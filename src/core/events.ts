type Fn = (...a: any[]) => void;

export function createEventBus() {
  const map = new Map<string, Set<Fn>>();
  return {
    on(type: string, fn: Fn) {
      if (!map.has(type)) map.set(type, new Set());
      map.get(type)!.add(fn);
    },
    off(type: string, fn: Fn) {
      map.get(type)?.delete(fn);
    },
    emit(type: string, ...args: any[]) {
      map.get(type)?.forEach(fn => fn(...args));
    },
  };
}
