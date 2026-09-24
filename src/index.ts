import Docker from 'dockerode';
import { PassThrough } from 'stream';

// Этот пакет не завязан на домен вызывающей стороны — только
// "образ + команда + лимиты → результат".

export interface ExecuteOptions {
  image: string;
  command: string;
  stdin?: string;
  timeoutMs: number;
  memoryLimitMb: number;
  cpuLimit: number;
  /** Хост-директория, монтируется в контейнер как рабочая (/workspace). */
  workdir?: string;
  /**
   * По умолчанию false — сеть наружу выключена. Включается вызывающей стороной,
   * которой она реально нужна (например, установщику пакетов для доступа к реестру).
   */
  network?: boolean;
  /**
   * Опциональный хук для стриминга вывода по мере поступления — помимо накопленных
   * stdout/stderr, которые в любом случае возвращаются целиком в ExecuteResult
   * после завершения команды.
   */
  onOutput?: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void;
}

export interface ExecuteResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
}

const PIDS_LIMIT = 256;

export async function execute(options: ExecuteOptions): Promise<ExecuteResult> {
  const docker = new Docker();
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

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    docker.modem.demuxStream(attachStream, stdout, stderr);

    stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stdoutBuf += text;
      options.onOutput?.({ stream: 'stdout', text });
    });
    stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderrBuf += text;
      options.onOutput?.({ stream: 'stderr', text });
    });

    await container.start();

    if (options.stdin) {
      attachStream.write(options.stdin);
      attachStream.end();
    }

    const timeout = new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), options.timeoutMs);
    });
    const wait = container.wait().then(() => 'done' as const);

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
  } finally {
    await container.remove({ force: true }).catch(() => undefined);
  }
}

export interface EnsureImageOptions {
  contextDir: string;
  dockerfile: string;
  tag: string;
}

/**
 * Собирает образ `tag` из `contextDir`/`dockerfile`, если его ещё нет локально.
 * Остаётся домен-агностичной операцией — просто общее удобство, чтобы каждый
 * вызывающий не переизобретал "собрать свой образ, если он отсутствует".
 */
export async function ensureImage(options: EnsureImageOptions): Promise<void> {
  const docker = new Docker();
  const images = await docker.listImages({ filters: { reference: [options.tag] } });
  if (images.length > 0) {
    return;
  }
  const stream = await docker.buildImage(
    { context: options.contextDir, src: [options.dockerfile] },
    { t: options.tag, dockerfile: options.dockerfile },
  );
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve()));
  });
}
