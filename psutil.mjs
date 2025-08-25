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

    const cwd = await realpath(`/proc/${pid}/cwd`)

    return {
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

export function mytop(pid, interval_seconds=3) {
    console.log('%CPU\tRSS (MB)\tRead (KB)\tWrite (KB)\tTime')

    let last_sample = null

    while (true) {
        await new Promise(res => setTimeout(res, interval_seconds * 1e3))

        const pstree = await getProcessTree_Linux(pid)
        const timestamp = Date.now() / 1e3
        for (const proc of pstree)
            proc.status = await getProcessStatus_Linux(proc.PID)

        const current_sample = {timestamp, pstree}

        if (last_sample) {
            const rss_mb = [...current_sample.pstree].reduce(
                (sum, proc) => sum + proc.status.rss_bytes, 0
            ) / 1e6
            const read_kb = (
                [...current_sample.pstree].reduce((sum, proc) => sum + proc.status.io.read_bytes, 0)
                - [...last_sample.pstree].reduce((sum, proc) => sum + proc.status.io.read_bytes, 0)
            ) / 1e3
            const write_kb = (
                [...current_sample.pstree].reduce((sum, proc) => sum + proc.status.io.write_bytes, 0)
                - [...last_sample.pstree].reduce((sum, proc) => sum + proc.status.io.write_bytes, 0)
            ) / 1e3

            const current_cpu_time = new Map(
                [...current_sample.pstree].map(proc => [proc.PID, proc.status.cpu_seconds])
            ), last_cpu_time = new Map(
                [...last_sample.pstree].map(proc => [proc.PID, proc.status.cpu_seconds])
            )
            let cpu_seconds = 0
            for (const [k, v] of current_cpu_time)
                if (last_cpu_time.has(k))
                    cpu_seconds += v - last_cpu_time.get(k)
            const cpu_usage = cpu_seconds / (current_sample.timestamp - last_sample.timestamp) * 100

            console.log(
                `${
                    cpu_usage.toFixed(2)
                }\t${
                    rss_mb.toFixed(2)
                }\t\t${
                    read_kb.toFixed(2)
                }\t\t${
                    write_kb.toFixed(2)
                }\t\t${
                    new Date(current_sample.timestamp*1e3).toLocaleTimeString()
                }`
            )
        }

        last_sample = current_sample
    }
}
