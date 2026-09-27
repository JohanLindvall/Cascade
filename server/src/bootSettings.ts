/** Environment-to-JSON startup settings, shared by the entrypoint and unit tests. */
import type { GlobalSettings } from './contracts';
import { OPTIONS } from './options';
import { SETTING_SPECS } from './settings';
import { requireBool, requireInt, requireString } from './validation';

export function startupSettings(env: NodeJS.ProcessEnv): Partial<GlobalSettings> {
  const values: Record<string, string | number | boolean> = {};
  for (const option of OPTIONS) {
    if (!option.setting) continue;
    const raw = env[option.name] || option.default;
    if (raw === undefined || raw === '') continue;
    const spec = SETTING_SPECS[option.setting];
    if (spec.kind === 'uint' || spec.kind === 'int') {
      const factor = option.kib ? 1024 : 1;
      values[option.setting] = requireInt(raw, option.name, spec.kind === 'int' ? -1 : 0,
        Math.floor(Number.MAX_SAFE_INTEGER / factor)) * factor;
    } else if (spec.kind === 'bool') values[option.setting] = requireBool(raw, option.name);
    else values[option.setting] = requireString(raw, option.name, true);
  }
  return values;
}

if (require.main === module) {
  try { process.stdout.write(`${JSON.stringify(startupSettings(process.env))}\n`); }
  catch (error) {
    console.error(`[cascade] invalid startup setting: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
