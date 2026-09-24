# sandbox-executor

Runs a shell command inside an isolated, resource-limited Docker container and
returns the result. That's the whole job — this package has no concept of a
"project", "build", "deployment", "lesson", or any other domain entity. A caller
hands it an image, a command, some limits, and (optionally) stdin; it hands back
stdout, stderr, exit code and duration.

It lives as a standalone project, a sibling directory next to
[Ranger](../ranger/README.md), not inside that repo — it has no dependency on
anything there. It isn't pushed to a git remote yet; once it is, consumers pull it
in as an ordinary dependency instead of copy-pasting the code.

## Why this exists

Ranger uses it to run a build's `install`/`test`/`build` steps. A separate,
unrelated project (a small algorithm-exercises platform) is expected to use the
exact same operation to run a student's solution against hidden tests. Same
mechanism, different content on the way in — so it's a standalone package rather
than code embedded in either project's build pipeline.

## Install

Once pushed to a git remote:

```jsonc
// consumer's package.json
{
  "dependencies": {
    "sandbox-executor": "github:<you>/sandbox-executor#v0.1.0"
  }
}
```

Until then, Ranger consumes it as a local path dependency
(`"sandbox-executor": "file:../../../sandbox-executor"` in
`apps/backend/package.json`) — which only works for local development, not for
Ranger's own Docker image build (Docker can't reach a path outside its build
context). That's a known, temporary gap: Ranger's backend image won't build until
this package has a real git URL to install from — see the note at the top of
`apps/backend/Dockerfile` in the Ranger repo.

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

This is the same posture whether the thing running inside is a `npm install` from
a trusted-ish read-only-deploy-key'd repo (Ranger) or an arbitrary student
submission (the exercises platform) — untrusted-input assumptions apply equally
to both.

## Requirements

The process calling `execute`/`ensureImage` needs access to a Docker socket
(`dockerode` connects to the default `/var/run/docker.sock` unless configured
otherwise). If that process itself runs inside a container with the host's
Docker socket mounted in (Docker-outside-of-Docker), `workdir` must be a path
that resolves correctly for the **host** daemon, not for the calling container —
see Ranger's own `apps/backend/src/builds/build-runner.service.ts` for how it
handles that translation.

## License

MIT — see [LICENSE](./LICENSE).
