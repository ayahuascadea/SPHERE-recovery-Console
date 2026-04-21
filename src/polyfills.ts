import { Buffer } from 'buffer';

const _global = (typeof window !== 'undefined' ? window : typeof global !== 'undefined' ? global : typeof self !== 'undefined' ? self : {});
(_global as any).global = _global;
(_global as any).Buffer = Buffer;

const _process = {
  env: { 
    NODE_ENV: 'production',
    DEBUG: undefined
  },
  browser: true,
  version: 'v18.0.0',
  versions: { node: '18.0.0', v8: '10.0.0' },
  argv: [],
  execArgv: [],
  platform: 'browser',
  cwd: () => '/',
  nextTick: (cb: any) => setTimeout(cb, 0),
  on: () => {},
  once: () => {},
  off: () => {},
  emit: () => {},
  listeners: () => [],
};

(_global as any).process = _process;

if (Buffer && Buffer.prototype && !Buffer.prototype.slice) {
  Buffer.prototype.slice = Buffer.prototype.subarray;
}

export {};
