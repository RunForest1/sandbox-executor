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
    onOutput?: (chunk: {
        stream: 'stdout' | 'stderr';
        text: string;
    }) => void;
}
export interface ExecuteResult {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    durationMs: number;
    timedOut: boolean;
}
export declare function execute(options: ExecuteOptions): Promise<ExecuteResult>;
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
export declare function ensureImage(options: EnsureImageOptions): Promise<void>;
