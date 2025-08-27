// @ts-check

/**
 * @param {number} pid
 */
export async function readProcDirOf_Linux(pid) {
    const {readFile, realpath, readdir} = await import('node:fs/promises')

    /**
     * @type {function(string):Promise<{Name: string, Pid: number, PPid: number, VmRSS: number}>}
     */  // @ts-ignore
    const parse_status = async path => Object.fromEntries(
        (await readFile(path, 'utf-8'))
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

    /**
     * @param {string} path
     */
    const parse_cmdline = async path => (
        await readFile(path, 'utf-8')
    ).slice(0, -1).split('\x00')

    /**
     * @param {string} path
     */
    const parse_comm = async path => (
        await readFile(path, 'utf-8')
    ).trim()


    /**
     * @param {string} path
     */
    const parse_io = async path => Object.fromEntries(
        (await readFile(path, 'ascii'))
            .split('\n')
            .filter(Boolean)
            .map(line => line.split(':', 2))
            .map(([k, v]) => [k, +v])
    )

    /**
     * @param {string} path
     */
    const parse_cwd = async path => (
        await realpath(path)
    ).replace(/\/+$/, '')

    /**
     * @param {string} path
     */
    const parse_stat = async path => (
        await readFile(path, 'utf-8')
    ).trim().split(' ')

    /**
     * @param {string} dir
     */
    const parse = async dir => {
        const stat = await parse_stat(`${dir}/stat`)
        const status = await parse_status(`${dir}/status`)
        const cmdline = await parse_cmdline(`${dir}/cmdline`)
        const comm = await parse_comm(`${dir}/comm`)
        const io = await parse_io(`${dir}/io`).catch(() => null)  // io 没权限读取的话就算了.
        const cwd = await parse_cwd(`${dir}/cwd`).catch(() => null)  // cwd 没权限读取的话就算了.
        return {
            stat: {
                ...stat,
                pid: +stat[0], comm: stat[1].slice(1, -1), state: stat[2], ppid: +stat[3],
                utime: +stat[13], stime: +stat[14], cutime: stat[15], cstime: stat[16],
                priority: +stat[17], nice: +stat[18], num_threads: +stat[19],
                starttime: +stat[21],
                vsize: +stat[22], rss: +stat[23],
                processor: +stat[38],
                rt_priority: +stat[39], policy: +stat[40],
                exit_code: +stat[51],
            },
            status, cmdline, comm, io, cwd,
        }
    }

    /**
     * @param {string} path
     */
    const parse_task = async path => Object.fromEntries(
        await Promise.all(
            (await readdir(path))
                .filter(name => /^\d+$/.test(name))
                .map(Number)
                .map(async tid => [tid, await parse(`${path}/${tid}`)])
        )
    )

    return {
        ...(await parse(`/proc/${pid}`)),
        task: await parse_task(`/proc/${pid}/task`),
    }
}

async function getAllProcDirs_Linux() {
    const {readdir} = await import('node:fs/promises')

    /**
     * @type {Map<number, Awaited<ReturnType<readProcDirOf_Linux>>>}
     */
    const dirOf = new Map
    await Promise.allSettled(
        (await readdir('/proc'))
            .filter(name => /^\d+$/.test(name))
            .map(Number)
            .map(
                async pid => dirOf.set(
                    pid,
                    await (async () => {
                        try {
                            return await readProcDirOf_Linux(pid)
                        } catch (e) {
                            console.error(e)
                            throw e
                        }
                    })()
                )
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
     * @prop {Awaited<ReturnType<readProcDirOf_Linux>>} self
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

    return /** @type {ProcessTree & Iterable<Awaited<ReturnType<readProcDirOf_Linux>>>} */ (node_of.get(pid))
}

/**
 * Usage:
 *   node --input-type=module -e "`cat ./psutil.mjs`;await mytop(process.pid, 5)"  # bash
 */
async function mytop(pid, interval_seconds=3) {
    const {getconf} = await import('./posix.mjs')
    const CLK_TCK = +await getconf('CLK_TCK')

    console.log('%CPU\tRSS (MB)\tRead (KB)\tWrite (KB)\tTime')

    /**
     * @type {[number, Map<number, Awaited<ReturnType<readProcDirOf_Linux>>> | null]}
     */
    let [last_timestamp, last_sample] = [0, null]

    const log = async () => {
        const this_timestamp = performance.now() / 1e3
        const tree = await makeProcTree_Linux(pid)
        /**
         * @type {Map<number, Awaited<ReturnType<readProcDirOf_Linux>>>}
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
                    if (dir.io === null)
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
                    if (dir.io === null)
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
