/**
 * 递归构建进程树, 读取 `/proc/<PID>/task/<PID>/children`.
 * @param {number} pid
 * @returns {object}
 * ```js
 * {
 *   PID: <PID>,
 *   subprocesses: [ ... ]
 * }
 * ```
 */
export async function getProcessTree_Linux(pid) {
    // Node.js
    const {readFile} = await import('fs/promises')

    const root = {
        *[Symbol.iterator]() {
            yield this
            yield* this.subprocesses
        },
        PID: pid,
        subprocesses: []
    }

    const subpids = (
        await readFile(`/proc/${pid}/task/${pid}/children`, {encoding: 'ascii'})
    ).split(/\s+/).filter(Boolean).map(Number)

    for (const child of subpids)
        root.subprocesses.push(await getProcessTree_Linux(child))

    return root
}

export async function getconf_Linux(variable) {
    // Node.js
    const {promisify} = await import('util')
    const {execFile} = await import('child_process')

    const {stdout} = await promisify(execFile)('getconf', [variable])
    return stdout.trim()
}

export async function getProcessStatus_Linux(pid) {
    // Node.js
    const {readFile} = require('fs/promises')

    const rss_bytes = (
        +(await readFile(`/proc/${pid}/statm`, 'ascii')).trim().split(/\s+/)[1]
    ) * (await getconf_Linux('PAGESIZE'))

    const stat = (await readFile(`/proc/${pid}/stat`, 'ascii')).trim().split(/\s+/)
    const cpu_seconds = (+stat[13] + +stat[14]) / (await getconf_Linux('CLK_TCK'))

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

    return {
        rss_bytes, io, cpu_seconds,
    }
}

export async function test(pid, {interval_seconds, num_samples} = {interval_seconds: 1, num_samples: 10}) {
    const samples = {}

    for (let i = 0; i != num_samples; ++i) {
        const pstree = await getProcessTree_Linux(pid)
        samples[Date.now()/1e3] = pstree

        for (const proc of pstree)
            proc.status = await getProcessStatus_Linux(proc.PID)

        await new Promise(res => setTimeout(res, interval_seconds * 1e3))
    }

    return samples
}
