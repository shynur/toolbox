/**
 * @param {string} variable - getconf 的 variable 参数
 * @return {Promise<string>}
 */
export async function getconf_Linux(variable) {
    const {promisify} = await import('node:util')
    const {execFile} = await import('node:child_process')

    const {stdout} = await promisify(execFile)('getconf', [variable])
    return stdout.trim()
}
