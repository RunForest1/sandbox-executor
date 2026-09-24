"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.execute = execute;
exports.ensureImage = ensureImage;
const dockerode_1 = __importDefault(require("dockerode"));
const stream_1 = require("stream");
const PIDS_LIMIT = 256;
async function execute(options) {
    const docker = new dockerode_1.default();
    const startedAt = Date.now();
    const container = await docker.createContainer({
        Image: options.image,
        Cmd: ['sh', '-c', options.command],
        WorkingDir: options.workdir ? '/workspace' : undefined,
        OpenStdin: Boolean(options.stdin),
        StdinOnce: Boolean(options.stdin),
        AttachStdin: Boolean(options.stdin),
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        HostConfig: {
            Binds: options.workdir ? [`${options.workdir}:/workspace`] : undefined,
            Memory: options.memoryLimitMb * 1024 * 1024,
            NanoCpus: Math.round(options.cpuLimit * 1_000_000_000),
            PidsLimit: PIDS_LIMIT,
            NetworkMode: options.network ? 'bridge' : 'none',
            CapDrop: ['ALL'],
            SecurityOpt: ['no-new-privileges'],
            AutoRemove: false,
        },
    });
    let stdoutBuf = '';
    let stderrBuf = '';
    let timedOut = false;
    try {
        const attachStream = await container.attach({
            stream: true,
            stdin: Boolean(options.stdin),
            stdout: true,
            stderr: true,
        });
        const stdout = new stream_1.PassThrough();
        const stderr = new stream_1.PassThrough();
        docker.modem.demuxStream(attachStream, stdout, stderr);
        stdout.on('data', (chunk) => {
            const text = chunk.toString('utf8');
            stdoutBuf += text;
            options.onOutput?.({ stream: 'stdout', text });
        });
        stderr.on('data', (chunk) => {
            const text = chunk.toString('utf8');
            stderrBuf += text;
            options.onOutput?.({ stream: 'stderr', text });
        });
        await container.start();
        if (options.stdin) {
            attachStream.write(options.stdin);
            attachStream.end();
        }
        const timeout = new Promise((resolve) => {
            setTimeout(() => resolve('timeout'), options.timeoutMs);
        });
        const wait = container.wait().then(() => 'done');
        const outcome = await Promise.race([wait, timeout]);
        if (outcome === 'timeout') {
            timedOut = true;
            await container.kill().catch(() => undefined);
            await container.wait().catch(() => undefined);
        }
        const inspection = await container.inspect();
        return {
            stdout: stdoutBuf,
            stderr: stderrBuf,
            exitCode: timedOut ? null : inspection.State.ExitCode,
            durationMs: Date.now() - startedAt,
            timedOut,
        };
    }
    finally {
        await container.remove({ force: true }).catch(() => undefined);
    }
}
/**
 * Собирает образ `tag` из `contextDir`/`dockerfile`, если его ещё нет локально.
 * Остаётся домен-агностичной операцией — просто общее удобство, чтобы каждый
 * вызывающий не переизобретал "собрать свой образ, если он отсутствует".
 */
async function ensureImage(options) {
    const docker = new dockerode_1.default();
    const images = await docker.listImages({ filters: { reference: [options.tag] } });
    if (images.length > 0) {
        return;
    }
    const stream = await docker.buildImage({ context: options.contextDir, src: [options.dockerfile] }, { t: options.tag, dockerfile: options.dockerfile });
    await new Promise((resolve, reject) => {
        docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve()));
    });
}
