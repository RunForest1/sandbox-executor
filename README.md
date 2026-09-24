# sandbox-executor

*[Читать на русском](./README.ru.md)*

Runs a shell command inside an isolated, resource-limited Docker container and
returns the result. That's the whole job — this package has no concept of a
"project", "build", "deployment", "lesson", or any other domain entity. A caller
hands it an image, a command, some limits, and (optionally) stdin; it hands back
stdout, stderr, exit code and duration.

It's a standalone package with no dependency on any consumer's codebase, meant to
be shared across multiple projects that each need to run untrusted or semi-trusted
commands in isolation, rather than having each project embed its own copy of this
logic.

## Why this exists

Different callers need the exact same operation — run a command in an isolated
container with limits and get the result back — with completely different content
on the way in: one might use it to run a CI build's `install`/`test`/`build`
steps, another to run a student's solution against hidden tests. Same mechanism,
different payload, so it lives as one small package rather than being duplicated
or entangled with either caller's domain logic.

## Install

With [bun](https://bun.sh):

```bash
bun add github:<you>/sandbox-executor#v0.1.0
```

Or add it to `package.json` by hand and run `bun install`:

```jsonc
// consumer's package.json
{
  "dependencies": {
    "sandbox-executor": "github:<you>/sandbox-executor#v0.1.0"
  }
}
```

Either way works the same with a plain git URL instead of `github:owner/repo`
(`bun add git+ssh://git@example.com/sandbox-executor.git#v0.1.0`), which is what
you need for a private repo without a GitHub-specific shorthand.

There's no npm-registry publish step for a git dependency, so nothing builds it on
your behalf — that's why `dist/` is committed to this repo rather than gitignored:
installing via bun gets you working, prebuilt JS immediately, no separate build
step required. If you change `src/`, run `bun run build` and commit the updated
`dist/` before tagging a new version.

## Usage

```ts
import { execute } from 'sandbox-executor';

const result = await execute({
  image: 'node:20-bookworm-slim',
  command: 'npm test',
  workdir: '/absolute/host/path/to/checkout', // mounted into the container as /workspace
  timeoutMs: 5 * 60 * 1000,
  memoryLimitMb: 512,
  cpuLimit: 1,
  network: true, // installers/test runners usually need registry access
  onOutput: (chunk) => process.stdout.write(chunk.text),
});

console.log(result.exitCode, result.durationMs, result.timedOut);
```

## API

```ts
interface ExecuteOptions {
  image: string;
  command: string;
  stdin?: string;
  timeoutMs: number;
  memoryLimitMb: number;
  cpuLimit: number;
  workdir?: string;   // host path, bind-mounted into the container as /workspace
  network?: boolean;  // default false — no outbound network
  onOutput?: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void;
}

interface ExecuteResult {
  stdout: string;
  stderr: string;
  exitCode: number | null; // null means it was killed for timing out
  durationMs: number;
  timedOut: boolean;
}

function execute(options: ExecuteOptions): Promise<ExecuteResult>;

interface EnsureImageOptions {
  contextDir: string;
  dockerfile: string;
  tag: string;
}

// Builds `tag` from `contextDir`/`dockerfile` if it doesn't already exist locally.
// Still domain-agnostic — just a shared convenience so every consumer doesn't
// reimplement "build my runtime image if missing".
function ensureImage(options: EnsureImageOptions): Promise<void>;
```

`network` and `onOutput` aren't part of a stricter, more minimal version of this
interface — they were added because a real caller needed them: `install` steps
generally need registry access, and a build UI wants to stream output live rather
than wait for the whole command to finish. Both are opt-in and don't leak any
domain concept into the package.

## Security posture

- No `--privileged`, no capabilities (`CapDrop: ['ALL']`), `no-new-privileges`.
- Hard CPU, memory and PID limits on every run.
- No outbound network unless the caller explicitly asks for it.
- A hard timeout that force-kills the container — a hung command doesn't hang
  the caller.
- The container is always removed after the run, success or failure.

This is the same posture regardless of what's running inside — a package install
from a repo the caller trusts to some degree, or an arbitrary, fully untrusted
submission — untrusted-input assumptions apply equally to both.

## Requirements

The process calling `execute`/`ensureImage` needs access to a Docker socket
(`dockerode` connects to the default `/var/run/docker.sock` unless configured
otherwise). If that process itself runs inside a container with the host's
Docker socket mounted in (Docker-outside-of-Docker), `workdir` must be a path
that resolves correctly for the **host** daemon, not for the calling container —
the calling process typically needs to bind-mount a directory from the host at a
known path and translate paths accordingly before calling `execute`.

## License

MIT — see [LICENSE](./LICENSE).
