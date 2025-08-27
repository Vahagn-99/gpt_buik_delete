export const makeLogger = (prefix = 'ext') => (ns: string) => {
  return (...args: any[]) => console.log(`[${prefix}:${ns}]`, ...args);
};
