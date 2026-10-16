import { readFile, rm } from 'node:fs/promises';
import { ComputerError } from './errors';
import { run } from './exec';
import { parseKeySequence, parseModifiers } from './keys';

export type MouseButton = 'left' | 'middle' | 'right';
export type ScrollDirection = 'up' | 'down' | 'left' | 'right';

const BUTTONS: Record<MouseButton, string> = { left: '1', middle: '2', right: '3' };
const WHEEL: Record<ScrollDirection, string> = { up: '4', down: '5', left: '6', right: '7' };

/** Xvnc's X input device for keys typed in VNC viewers. */
const VNC_KEYBOARD = 'TigerVNC keyboard';

async function xdotool(args: string[], timeoutMs = 15_000): Promise<string> {
  const r = await run('xdotool', args, { timeoutMs });
  if (r.timedOut) throw new ComputerError('action_timeout', `xdotool ${args[0]} timed out`);
  if (r.exitCode !== 0) {
    throw new ComputerError('invalid_argument', `xdotool ${args[0]} failed: ${r.stderr.trim()}`);
  }
  return r.stdout.trim();
}

/**
 * The X side of the computer: real input (as a person would produce it, so it
 * works for any app, not just the browser), window info and screen capture.
 */
export class Desktop {
  async screenSize(): Promise<{ width: number; height: number }> {
    const out = await xdotool(['getdisplaygeometry']);
    const [width, height] = out.split(/\s+/).map(Number);
    return { width, height };
  }

  /** Title of the focused window, or null (e.g. bare desktop). */
  async activeWindowTitle(): Promise<string | null> {
    const r = await run('xdotool', ['getactivewindow', 'getwindowname'], { timeoutMs: 5_000 });
    return r.exitCode === 0 ? r.stdout.trim() || null : null;
  }

  async click(
    x: number,
    y: number,
    opts: { button?: MouseButton; double?: boolean; modifiers?: string } = {},
  ): Promise<void> {
    const mods = parseModifiers(opts.modifiers);
    const args = ['mousemove', '--sync', String(x), String(y)];
    if (mods.length) args.push('keydown', mods.join('+'));
    args.push('click');
    if (opts.double) args.push('--repeat', '2', '--delay', '80');
    args.push(BUTTONS[opts.button ?? 'left']);
    // keyup in the same xdotool invocation: an interrupted call can't leave a
    // modifier logically held.
    if (mods.length) args.push('keyup', mods.join('+'));
    await xdotool(args);
  }

  async typeText(text: string): Promise<void> {
    // Long texts: xdotool types ~100 chars/s at this delay.
    const timeoutMs = Math.max(15_000, text.length * 40);
    await xdotool(['type', '--clearmodifiers', '--delay', '8', '--', text], timeoutMs);
  }

  async pressKeys(keys: string): Promise<void> {
    await xdotool(['key', '--clearmodifiers', '--delay', '40', ...parseKeySequence(keys)]);
  }

  async scroll(x: number, y: number, direction: ScrollDirection, amount: number): Promise<void> {
    await xdotool([
      'mousemove',
      '--sync',
      String(x),
      String(y),
      'click',
      '--repeat',
      String(amount),
      '--delay',
      '30',
      WHEEL[direction],
    ]);
  }

  async drag(fromX: number, fromY: number, toX: number, toY: number): Promise<void> {
    await xdotool([
      'mousemove', '--sync', String(fromX), String(fromY),
      'mousedown', '1',
      'mousemove', '--sync', String(Math.round((fromX + toX) / 2)), String(Math.round((fromY + toY) / 2)),
      'mousemove', '--sync', String(toX), String(toY),
      'mouseup', '1',
    ]);
  }

  /** Full-resolution PNG of the whole screen. */
  async capturePng(): Promise<Buffer> {
    const path = `/tmp/teros-shot-${process.pid}-${Date.now()}.png`;
    const r = await run('scrot', ['--overwrite', '--silent', path], { timeoutMs: 15_000 });
    if (r.exitCode !== 0) {
      throw new ComputerError('screenshot_failed', r.stderr.trim() || `scrot exited ${r.exitCode}`);
    }
    try {
      return await readFile(path);
    } finally {
      await rm(path, { force: true });
    }
  }

  /**
   * Let VNC viewers send input (human in control) or not (agent in control),
   * enforced inside the X server so no client can bypass it:
   *   - keyboard: TigerVNC can't change AcceptKeyEvents at runtime, so Xvnc
   *     starts accepting keys and its own "TigerVNC keyboard" X device is
   *     disabled/enabled (X drops events from a disabled device; the agent's
   *     xdotool input goes through the separate XTEST device);
   *   - pointer + clipboard: runtime-settable Xvnc parameters.
   * Every change is read back; a mismatch throws (fail closed).
   */
  async setViewerInput(enabled: boolean): Promise<void> {
    const v = enabled ? '1' : '0';
    for (const param of ['AcceptPointerEvents', 'AcceptCutText']) {
      const set = await run('vncconfig', ['-set', `${param}=${v}`], { timeoutMs: 5_000 });
      // vncconfig exits 0 even when the server refuses ("setting param … failed").
      const get = await run('vncconfig', ['-get', param], { timeoutMs: 5_000 });
      if (/failed/i.test(set.stdout + set.stderr) || get.stdout.trim() !== v) {
        throw new Error(`could not set ${param}=${v}: ${(set.stderr || set.stdout).trim()}`);
      }
    }
    const action = enabled ? 'enable' : 'disable';
    const r = await run('xinput', [action, VNC_KEYBOARD], { timeoutMs: 5_000 });
    const props = await run('xinput', ['list-props', VNC_KEYBOARD], { timeoutMs: 5_000 });
    const state = props.stdout.match(/Device Enabled \(\d+\):\s*(\d)/)?.[1];
    if (r.exitCode !== 0 || state !== v) {
      throw new Error(`could not ${action} the VNC keyboard: ${r.stderr.trim() || `state=${state}`}`);
    }
  }
}
