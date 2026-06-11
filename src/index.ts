#!/usr/bin/env node
/**
 * Stdio entry point: argv parsing + server startup.
 *
 * ABSOLUTELY no stdout writes here or anywhere on the server runtime path — stdout is the
 * MCP JSON-RPC wire and a single stray line corrupts the session. Diagnostics go to
 * console.error (stderr) only.
 */

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { BackendPreference } from './render/backend.js';
import { buildServer } from './server.js';

const USAGE = `Usage: vs-shapes-mcp [--game-path <dir>] [--renderer <webgpu|software|auto>]

  --game-path <dir>   Vintage Story install directory (the folder containing "assets").
                      Default: VINTAGE_STORY env var, then %APPDATA%/Vintagestory.
                      Only corpus tools and texture resolution need it; pure editing
                      works without any install.
  --renderer <mode>   Rasterizer for render tools: webgpu, software, or auto (default;
                      tries WebGPU/Dawn and falls back to software).
  --help              Print this help (to stderr) and exit.`;

interface CliOpts {
  gamePath?: string;
  renderer: BackendPreference;
}

/** Parses argv; throws with a usage-bearing message on anything malformed. */
export function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = { renderer: 'auto' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    // Accept both `--flag value` and `--flag=value`.
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    const next = (): string => {
      if (inline !== undefined) return inline;
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) {
        throw new Error(`${flag} needs a value.\n${USAGE}`);
      }
      return v;
    };
    switch (flag) {
      case '--game-path':
        opts.gamePath = next();
        break;
      case '--renderer': {
        const v = next();
        if (v !== 'webgpu' && v !== 'software' && v !== 'auto') {
          throw new Error(`--renderer must be webgpu, software or auto, got '${v}'.\n${USAGE}`);
        }
        opts.renderer = v;
        break;
      }
      case '--help':
      case '-h':
        console.error(USAGE);
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument '${arg}'.\n${USAGE}`);
    }
  }
  return opts;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const server = buildServer(opts);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `vs-shapes-mcp: listening on stdio (renderer ${opts.renderer}` +
      (opts.gamePath !== undefined ? `, game path ${opts.gamePath}` : '') +
      `)`,
  );
}

/** True when this module is the executed entry (node dist/index.js / tsx src/index.ts). */
function isMain(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    // realpath both sides: npm bin shims are symlinks while import.meta.url is resolved.
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  main().catch((e: unknown) => {
    console.error(`vs-shapes-mcp: fatal: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
