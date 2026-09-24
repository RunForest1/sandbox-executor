import Docker from 'dockerode';
import { PassThrough } from 'stream';

// Этот пакет не знает ничего про Ranger (project/build/deployment) и ни про какой
// другой домен — только "образ + команда + лимиты → результат". См. раздел 9 CLAUDE.md.
// Он также используется вне Ranger как исполнитель решений в учебной платформе.

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
   * По умолчанию false — сеть наружу выключена (раздел 9 CLAUDE.md: "без сети наружу
   * по умолчанию"). Не часть исходного интерфейса из CLAUDE.md — добавлено, потому что
   * без него install-шаг сборки (npm/bun/pip install) в принципе не может работать;
   * судья для учебных задач сети не запрашивает и получает безопасный дефолт.
   */
  network?: boolean;
  /**
   * Не часть исходного интерфейса из CLAUDE.md — добавлено для живого стриминга вывода
   * (раздел 1 CLAUDE.md: "живой лог по WebSocket"). Финальные stdout/stderr всё равно
   * возвращаются целиком в ExecuteResult, onOutput — только для потребителей, которым
   * нужен вывод по мере поступления.
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
 * Не часть исходного интерфейса из CLAUDE.md, но остаётся домен-агностичной операцией
 * (собрать образ по Dockerfile, если его ещё нет) — нужна обоим потребителям пакета,
 * поэтому живёт здесь, а не дублируется в каждом из них.
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
