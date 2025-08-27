import { makeLogger } from '@core/logger';
import { createEventBus } from '@core/events';
import { el } from '@core/dom';
import { storage } from '@core/storage';
import type { Module, ModuleCtx } from '@core/types';

import { registry } from '../_generated/registry';
import { enabledModules, orderOverrides } from '@config/modules';

const logger = makeLogger('ext');
const events = createEventBus();

const ctx: ModuleCtx = {
  logger,
  el,
  events,
  storage
};

function sortModules(mods: any[]): Module[] {
  const mapped: Module[] = mods
    .map((m) => (m?.moduleDef ?? m?.default ?? m))
    .filter(Boolean);

  mapped.forEach(m => {
    if (orderOverrides[m.id] != null) m.order = orderOverrides[m.id];
  });

  return mapped
    .filter(m => enabledModules[m.id] !== false)
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
}

(async function bootstrap() {
  try {
    const mods = sortModules(registry as any[]);
    logger('main')(`modules: ${mods.map(m => m.id).join(', ') || 'none'}`);
    for (const m of mods) {
      await m.init(ctx);
    }
  } catch (e) {
    logger('main')('bootstrap error', e);
  }
})();
