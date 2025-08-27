export interface ModuleCtx {
  logger: (ns: string) => (...args: any[]) => void;
  el: {
    $(sel: string, root?: ParentNode | Document): Element | null;
    $all(sel: string, root?: ParentNode | Document): Element[];
  };
  events: {
    on(type: string, fn: (...a: any[]) => void): void;
    off(type: string, fn: (...a: any[]) => void): void;
    emit(type: string, ...args: any[]): void;
  };
  storage: {
    get<T = any>(key: string): Promise<T | undefined>;
    set<T = any>(key: string, val: T): Promise<void>;
    remove(key: string): Promise<void>;
  };
}

export interface Module {
  id: string;
  order?: number;
  init(ctx: ModuleCtx): void | Promise<void>;
  stop?(ctx: ModuleCtx): void | Promise<void>;
}
