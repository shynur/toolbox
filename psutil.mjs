// @ts-check

/**
 *
 * @param {number} pid
 */
async function readProcDirOf(pid) {
    const {readFile, realpath} = await import('node:fs/promises')

    /**
     * @type {{Name: string, Pid: number, PPid: number, VmRSS: number}}
     *
     */  // @ts-ignore
    const status = Object.freeze(
        Object.fromEntries(
            (await readFile(`/proc/${pid}/status`, 'utf-8'))
                .split('\n')
                .filter(Boolean)
                .map(line => line.split(':', 2).map(s => s.trim()))
                .filter(([k]) => k)
                .map(([k, v]) => [
                    k, (() => {
                        switch (k) {
                            case 'Pid': return +v
                            case 'PPid': return +v
                            case 'VmRSS': {
                                if (v.endsWith('kB'))
                                    return parseInt(v) * 1024
                                return +v
                            }
                            default: return v
                        }
                    })()
                ])
        )
    )

    const cmdline = (
        await readFile(`/proc/${pid}/cmdline`, 'utf-8')
    ).slice(0, -1).split('\x00')

    const comm = (await readFile(`/proc/${pid}/comm`, 'utf-8')).trim()

    const io = Object.freeze(
        Object.fromEntries(
            (await readFile(`/proc/${pid}/io`, 'ascii'))
                .split('\n')
                .filter(Boolean)
                .map(line => line.split(':', 2))
                .map(([k, v]) => [k, +v])
        )
    )

    const cwd = (await realpath(`/proc/${pid}/cwd`)).replace(/\/+$/, '')

    /**
     * @type {string[]}
     */
    const stat = (await readFile(`/proc/${pid}/stat`, 'utf-8')).trim().split(' ')

    return {
        stat: Object.freeze({
            pid: +stat[0], comm: stat[1].slice(1, -1), state: stat[2], ppid: +stat[3],
            utime: +stat[13], stime: +stat[14], cutime: stat[15], cstime: stat[16],
            priority: +stat[17], nice: +stat[18], num_threads: +stat[19],
            starttime: +stat[21],
            vsize: +stat[22], rss: +stat[23],
            processor: +stat[38],
            rt_priority: +stat[39], policy: +stat[40],
            exit_code: +stat[51],
        }),
        status, cmdline, comm, io, cwd,
    }
}

async function getAllProcDirs_Linux() {
    const {readdir} = await import('node:fs/promises')

    /**
     * @type {Map<number, Awaited<ReturnType<readProcDirOf>>>}
     */
    const dirOf = new Map
    await Promise.allSettled(
        (await readdir('/proc'))
            .filter(name => /^\d+$/.test(name))
            .map(Number)
            .map(
                async pid => dirOf.set(pid, await readProcDirOf(pid))
            )
    )

    return dirOf
}

/**
 * @param {number} pid
 */
export async function makeProcTree_Linux(pid) {
    const dir_of = await getAllProcDirs_Linux()

    /**
     * @typedef {Object} ProcessTree
     * @prop {Awaited<ReturnType<readProcDirOf>>} self
     * @prop {ProcessTree[]} children
     */

    /**
     * @type {Map<number, ProcessTree>}
     */
    const node_of = new Map
    for (const [pid, dir] of dir_of)
        node_of.set(pid, {
            self: dir,
            children: [],
            // @ts-ignore
            *[Symbol.iterator]() {
                yield this.self
                for (const child of this.children) {
                    // @ts-ignore
                    yield* child
                }
            }
        })
    for (const [pid, node] of node_of) {
        // @ts-ignore
        const ppid = dir_of.get(pid).status.PPid
        if (!node_of.has(ppid))
            continue
        if (ppid === pid)
            continue
        // @ts-ignore
        node_of.get(ppid).children.push(node)
    }

    return /** @type {ProcessTree & Iterable<Awaited<ReturnType<readProcDirOf>>>} */ (node_of.get(pid))
}

export async function mytop(pid, interval_seconds=3) {
    const {getconf} = await import('./posix.mjs')
    const CLK_TCK = +await getconf('CLK_TCK')

    console.log('%CPU\tRSS (MB)\tRead (KB)\tWrite (KB)\tTime')

    /**
     * @type {[number, Map<number, Awaited<ReturnType<readProcDirOf>>> | null]}
     */
    let [last_timestamp, last_sample] = [0, null]

    const log = async () => {
        const this_timestamp = performance.now() / 1e3
        const tree = await makeProcTree_Linux(pid)
        /**
         * @type {Map<number, Awaited<ReturnType<readProcDirOf>>>}
         */
        const this_sample = new Map
        for (const proc of tree)
            this_sample.set(proc.status.Pid, proc)

        if (last_sample) {
            const cpu_seconds = [
                ...this_sample.entries()
            ].reduce(
                (sum, [pid, dir]) => {
                    // @ts-ignore
                    if (!last_sample.has(pid))
                        return sum
                    return sum + (
                        dir.stat.utime + dir.stat.stime
                        // @ts-ignore
                        - last_sample.get(pid).stat.utime - last_sample.get(pid).stat.stime
                    )
                }, 0
            ) / CLK_TCK

            const rss_mb = [...this_sample.values()].reduce(
                (sum, dir) => sum + dir.status.VmRSS, 0
            ) / 1e6

            const read_kb = [
                ...this_sample
            ].reduce(
                (sum, [pid, dir]) => {
                    // @ts-ignore
                    if (!last_sample.has(pid))
                        return sum
                    return sum + (
                        dir.io.read_bytes
                        // @ts-ignore
                        - last_sample.get(pid).io.read_bytes
                    )
                }, 0
            ) / 1e3, write_kb = [
                ...this_sample
            ].reduce(
                (sum, [pid, dir]) => {
                    // @ts-ignore
                    if (!last_sample.has(pid))
                        return sum
                    return sum + (
                        dir.io.write_bytes
                        // @ts-ignore
                        - last_sample.get(pid).io.write_bytes
                    )
                }, 0
            ) / 1e3

            console.log(
                `${
                    (cpu_seconds / (this_timestamp - last_timestamp) * 100).toFixed(2)
                }\t${
                    rss_mb.toFixed(2)
                }\t\t${
                    read_kb.toFixed(2)
                }\t\t${
                    write_kb.toFixed(2)
                }\t\t${
                    new Date().toLocaleTimeString()
                }`
            )
        }

        [last_timestamp, last_sample] = [this_timestamp, this_sample]
    }

    while (true) {
        await log()
        await new Promise(res => setTimeout(res, interval_seconds * 1e3))
    }
}
