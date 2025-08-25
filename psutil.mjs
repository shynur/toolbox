// @ts-check

/**
 * 递归构建进程树, 读取 `/proc/<PID>/task/<PID>/children`.
 * @param {number} pid
 * @return {Promise<Process>}
 */
export async function getProcessTree_Linux(pid) {
    const {readFile} = await import('node:fs/promises')

    /** @typedef {Object} Process */
    const root = {
        PID: pid,
        *[Symbol.iterator]() {
            yield this
            for (const proc of this.children)
                yield* proc
        },
        /** @type {Process[]} */
        children: []
    }

    const children_pids = (
        await readFile(`/proc/${pid}/task/${pid}/children`, {encoding: 'ascii'})
    ).split(/\s+/).filter(Boolean).map(Number)

    await Promise.all(
        children_pids.map(
            async child =>
                root.children.push(await getProcessTree_Linux(child))
        )
    )

    return root
}

/**
 *
 * @param {string} variable - getconf 的 variable 参数
 * @return {Promise<string>}
 */
export async function getconf_Linux(variable) {
    const {promisify} = await import('node:util')
    const {execFile} = await import('node:child_process')

    const {stdout} = await promisify(execFile)('getconf', [variable])
    return stdout.trim()
}

/**
 * @param {number} pid
 */
export async function getProcessStatus_Linux(pid) {
    const {readFile} = require('node:fs/promises')

    const rss_bytes =
        +(await readFile(`/proc/${pid}/statm`, 'ascii')).trim().split(/\s+/)[1]
    * +(await getconf_Linux('PAGESIZE'))

    const stat = (await readFile(`/proc/${pid}/stat`, 'ascii')).trim().split(/\s+/)
    const executable = stat[1].slice(1, -1)
    const cpu_seconds = (+stat[13] + +stat[14]) / +(await getconf_Linux('CLK_TCK'))

    const io = Object.fromEntries(
        (await readFile(`/proc/${pid}/io`, 'ascii'))
            .trim()
            .split('\n')
            .map(
                line => {
                    const [k, v] = line.split(':').map(s => s.trim())
                    return [k, +v]
                }
            )
    )

    const cmdline = (await readFile(`/proc/${pid}/cmdline`, 'ascii')).split('\0')[0]

    return {
        rss_bytes, io, cpu_seconds, cmdline, executable
    }
}

export async function mytop(pid, interval_seconds=1) {
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
                `${cpu_usage.toFixed(2)}\t${rss_mb.toFixed(2)}\t\t${read_kb.toFixed(2)}\t\t${write_kb.toFixed(2)}\t\t${
                    new Date(current_sample.timestamp*1e3).toLocaleTimeString()
                }`
            )
        }

        last_sample = current_sample
    }
}
