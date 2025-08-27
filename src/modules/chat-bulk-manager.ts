import type { Module, ModuleCtx } from '@core/types';

/**
 * Уникальный ID модуля (используется в конфиге и логах)
 */
export const id = 'chat-bulk-manager';

/**
 * Порядок инициализации (меньше — раньше)
 */
export const order = 10;

/* =====================================================================================
 *                                        TYPES
 * ===================================================================================== */

/**
 * Параметры инициализации ChatBulkUI
 */
export interface ChatBulkOptions {
  /** Включён ли модуль (если false — рисуем бар, но без поведения) */
  enabled?: boolean;
  /** Включать ли стелс-режим (скрывает всплывающие меню во время автокликов) */
  stealth?: boolean;
  /** Количество параллельных воркеров удаления (1..4) */
  concurrency?: number;
  /** Пауза между удалениями (мс) для смягчения нагрузки на UI */
  staggerMs?: number;
  /** Максимальное ожидание появления меню (мс) */
  maxMenuWaitMs?: number;
  /** Максимальное ожидание появления диалога подтверждения (мс) */
  maxDialogWaitMs?: number;
  /** Количество попыток клика по кнопке с меню */
  clickRetries?: number;
  /** Пауза между попытками клика по кнопке с меню (мс) */
  clickRetryDelay?: number;
  /** Пауза после успешного удаления (мс) — дать UI перестроиться */
  afterDeleteWaitMs?: number;
}

/** Карточка выделенного чата */
interface SelectedItem {
  href: string;
}

/* =====================================================================================
 *                                  ChatBulkUI (core)
 * ===================================================================================== */

/**
 * Менеджер массового удаления чатов в боковой панели chatgpt.com
 *
 * Архитектура:
 *  - lifecycle: start/detach
 *  - helpers: normalizePath/extractId/... поиск и работа с DOM
 *  - checkboxes: отрисовка/поддержка чекбоксов в строках
 *  - action bar: панель действий (выбрать всё/сброс/удалить)
 *  - bulk delete: конвейер удаления (несколько воркеров)
 *  - ui actions: сценарий удаления через меню и подтверждение
 *  - low-level events: клики и открытия меню
 *  - waiters/misc: утилиты ожиданий/скролла
 */
class ChatBulkUI {
  /* -------------------------- options / state -------------------------- */

  /** Текущие опции */
  private readonly opts: Required<ChatBulkOptions>;

  /** Выделенные элементы: id → { href } */
  private selected: Map<string, SelectedItem> = new Map();

  /** Ссылка на панель действий */
  private actionBar: HTMLDivElement | null = null;

  /** Наблюдатель за DOM для авто-подклейки чекбоксов */
  private obs: MutationObserver | null = null;

  /* ------------------------------ ctor ------------------------------- */

  /**
   * @param options Пользовательские настройки
   */
  constructor(options: ChatBulkOptions = {}) {
    const {
      enabled = true,
      stealth = true,
      concurrency = 2,
      staggerMs = 50,
      maxMenuWaitMs = 3500,
      maxDialogWaitMs = 7000,
      clickRetries = 8,
      clickRetryDelay = 140,
      afterDeleteWaitMs = 140
    } = options;

    // нормализуем и фиксируем опции
    this.opts = {
      enabled,
      stealth,
      concurrency: Math.max(1, Math.min(4, concurrency)),
      staggerMs,
      maxMenuWaitMs,
      maxDialogWaitMs,
      clickRetries,
      clickRetryDelay,
      afterDeleteWaitMs
    };
  }

  /* ===================================================================================
   *                                     lifecycle
   * =================================================================================== */

  /**
   * Точка запуска:
   *  - отрисовывает чекбоксы рядом с чатами
   *  - рисует панель действий
   *  - вешает наблюдатель мутаций
   */
  public start(): void {
    if (!this.opts.enabled) {
      this.detach();
      this.renderBar();
      this.updateBar();
      
      return;

    }

    this.attachCheckboxes();
    this.renderBar();
    this.bindGlobal();
    this.updateBar();
  }

  /**
   * Полная очистка: убираем чекбоксы, чистим выделение
   */
  public detach(): void {
    document.querySelectorAll<HTMLInputElement>('.cbm-checkbox').forEach(el => el.remove());
    this.selected.clear();
  }

  /* ===================================================================================
   *                                   helpers: URL/DOM
   * =================================================================================== */

  /**
   * Нормализация пути URL (убираем query и слеш в конце)
   */
  private normalizePath(href: string | null | undefined): string {
    try {
      const u = new URL(href ?? '', location.origin);
      return u.pathname.replace(/\/+$/, '');
    } catch {
      return (href || '').split('?')[0].replace(/\/+$/, '');
    }
  }

  /**
   * Извлекаем ID чата из href: /c/<uuid> (поддерживает варианты /g/.../c/<uuid>)
   */
  private extractIdFromHref(href: string | null | undefined): string | null {
    if (!href) return null;
    const path = this.normalizePath(href);
    const m = path.match(/\/c\/([a-z0-9-]+)\/?$/i);
    return m ? m[1] : null;
  }

  /**
   * Ищем корень сайдбара
   */
  private findSidebar(): HTMLElement | null {
    return document.querySelector<HTMLElement>('[data-testid="nav"]');
  }

  /**
   * Поиск строки чата по href (точное совпадение пути)
   */
  private findRowByHref(href: string): HTMLAnchorElement | null {
    const targetPath = this.normalizePath(href);
    const scope = this.findSidebar() || document;
    const all = scope.querySelectorAll<HTMLAnchorElement>('a.group.__menu-item.hoverable[href*="/c/"]');


    for (const a of Array.from(all)) {
      try {
        if (this.normalizePath(a.href) === targetPath) return a;
      } catch {
        /* ignore */
      }
    }
    return null;
  }

  /* ===================================================================================
   *                                      checkboxes
   * =================================================================================== */

  /**
   * Вешает чекбоксы на все строки чатов (ленивая переинициализация допустима)
   */
  private attachCheckboxes(): void {
    if (!this.opts.enabled) return;

    const sidebar = this.findSidebar() || document;
    const rows = sidebar.querySelectorAll<HTMLAnchorElement>('a.group.__menu-item.hoverable[href*="/c/"]');

    rows.forEach((row) => {
      if (row.querySelector<HTMLInputElement>('.cbm-checkbox')) return;

      const href = row.getAttribute('href');
      const id = this.extractIdFromHref(href);
      if (!id || !href) return;

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'cbm-checkbox';

      // не даём чекбоксу "прокликивать" по строке
      const stop = (e: Event) => { e.stopPropagation(); (e as any).stopImmediatePropagation?.(); };
      cb.addEventListener('pointerdown', stop, true);
      cb.addEventListener('mousedown', stop, true);
      cb.addEventListener('click', stop, true);

      cb.addEventListener('change', () => {
        if (cb.checked) this.selected.set(id, { href });
        else this.selected.delete(id);
        this.updateBar();
      });

      row.classList.add('cbm-row');
      row.insertBefore(cb, row.firstChild);
    });
  }

  /* ===================================================================================
   *                                   action bar (UI)
   * =================================================================================== */

  /**
   * Рендер панели действий (прикрепляем в сайдбар, если он есть)
   */
  private renderBar(): void {
    if (this.actionBar) return;

    const bar = document.createElement('div');
    bar.className = 'cbm-bar cbm-hidden';
    bar.innerHTML = `
      <div class="cbm-left">
        <span>Выбрано: <span class="cbm-count">0</span></span>
        <span class="cbm-progress-pill" title="Прогресс" hidden>0/0</span>
      </div>
      <div class="cbm-center cbm-loader" hidden>
        <div class="cbm-spinner"></div>
        <span class="cbm-status"></span>
      </div>
      <div class="cbm-right">
        <button class="cbm-select-all btn">Выбрать всё</button>
        <button class="cbm-del btn btn-danger">Удалить</button>
        <button class="cbm-clear btn">Снять выбор</button>
      </div>
    `;

    // Пробуем встроить в сайдбар
    const sidebar = this.findSidebar();
    if (sidebar) {
      const host = sidebar.querySelector<HTMLElement>('[data-overlaysscrollbars-viewport]') || sidebar;
      host.prepend(bar);
      bar.classList.add('cbm--sidebar');
    } else {
      document.body.appendChild(bar);
      Object.assign(bar.style, {
        position: 'fixed',
        top: '0px',
        left: '0px',
        right: '0px',
        zIndex: '2147483647'
      } as CSSStyleDeclaration);
    }

    bar.querySelector<HTMLButtonElement>('.cbm-clear')?.addEventListener('click', () => this.clearSelection());
    bar.querySelector<HTMLButtonElement>('.cbm-del')?.addEventListener('click', () => this.runBulkDelete());
    bar.querySelector<HTMLButtonElement>('.cbm-select-all')?.addEventListener('click', () => this.selectAll());

    this.actionBar = bar as HTMLDivElement;
  }

  /**
   * Обновляет визуальное состояние панели
   */
  private updateBar(): void {
    if (!this.actionBar) return;

    const n = this.selected.size;
    const running = this.actionBar.classList.contains('running');

    const countEl = this.actionBar.querySelector<HTMLElement>('.cbm-count');
    if (countEl) countEl.textContent = String(n);

    const shouldShow = running || n > 0;
    this.actionBar.classList.toggle('cbm-hidden', !shouldShow);

    const delBtn = this.actionBar.querySelector<HTMLButtonElement>('.cbm-del');
    if (delBtn) delBtn.disabled = !this.opts.enabled || n === 0 || running;

    const clr = this.actionBar.querySelector<HTMLButtonElement>('.cbm-clear');
    if (clr) clr.disabled = (n === 0 || running);

    const selAll = this.actionBar.querySelector<HTMLButtonElement>('.cbm-select-all');
    if (selAll) selAll.disabled = running;
  }

  /**
   * Снимает все выделения и обновляет панель
   */
  private clearSelection(): void {
    document.querySelectorAll<HTMLInputElement>('.cbm-checkbox:checked').forEach(cb => (cb.checked = false));
    this.selected.clear();
    this.updateBar();
  }

  /**
   * Выбирает все чаты в текущем DOM сайдбара
   */
  private selectAll(): void {
    const sidebar = this.findSidebar() || document;
    const rows = sidebar.querySelectorAll<HTMLAnchorElement>('a.group.__menu-item.hoverable[href*="/c/"]');
    let any = 0;

    rows.forEach(row => {
      const href = row.getAttribute('href');
      const id = this.extractIdFromHref(href);
      if (!id || !href) return;

      let cb = row.querySelector<HTMLInputElement>('.cbm-checkbox');
      if (!cb) { this.attachCheckboxes(); cb = row.querySelector<HTMLInputElement>('.cbm-checkbox'); }
      if (cb && !cb.checked) { cb.checked = true; any++; }

      this.selected.set(id, { href });
    });

    this.updateBar();
    if (!any) this.flashError('Нечего выбирать', 900);
  }

  /**
   * Подписка на мутации DOM, чтобы при динамике списка чатов
   * (виртуализация, ленивый рендер) чекбоксы появлялись автоматически
   */
  private bindGlobal(): void {
    if (this.obs) this.obs.disconnect();
    this.obs = new MutationObserver(() => {
      if (this.opts.enabled) this.attachCheckboxes();
    });
    this.obs.observe(document.body, { subtree: true, childList: true });
  }

  /* ===================================================================================
   *                                  navigation guard
   * =================================================================================== */

  /**
   * Гарантируем, что мы не находимся на странице одного из выбранных чатов —
   * иначе при удалении SPA может перезагрузить страницу/маршрут.
   */
  private async ensureNotOnSelected(items: Array<{ href: string }>): Promise<void> {
    const selectedPaths = new Set(items.map(it => this.normalizePath(it.href)));
    const here = this.normalizePath(location.href);
    if (!selectedPaths.has(here)) return;

    const newBtn = document.querySelector<HTMLButtonElement>('[data-testid="new-chat-button"]');
    if (newBtn) {
      try { newBtn.click(); } catch { /* ignore */ }
      await this.waitSidebarReady(4000);
      return;
    }

    try { history.pushState(null, '', '/'); window.dispatchEvent(new PopStateEvent('popstate')); }
    catch {
      try { location.assign('/'); } catch { /* ignore */ }
    }
    await this.waitSidebarReady(4000);
  }

  /* ===================================================================================
   *                                    bulk delete
   * =================================================================================== */

  /**
   * Запускает конвейер удаления выбранных чатов.
   * Работает несколькими воркерами (concurrency), аккуратно обновляет UI.
   */
  private async runBulkDelete(): Promise<void> {
    if (!this.opts.enabled) return;

    const items = [...this.selected.entries()].map(([id, ctx]) => ({ id, href: ctx.href }));
    if (!items.length) return;

    await this.ensureNotOnSelected(items);

    let processed = 0, ok = 0, fail = 0;
    const total = items.length;

    this.actionBar?.classList.add('running');
    this.showLoader(true);
    this.setProgress(processed, total);
    this.setStatus(`Удаление… ${processed}/${total}`);
    this.updateBar();

    if (this.opts.stealth) document.documentElement.setAttribute('data-cbm-stealth', '');

    try {
      let i = 0;

      const worker = async () => {
        while (i < items.length) {
          const it = items[i++];

          try {
            await this.deleteViaUI(it.href);
            ok++;
          } catch (e: unknown) {
            fail++;
            // eslint-disable-next-line no-console
            console.warn('[cbm] E_DELETE', it.id, e);
            this.flashError((e as Error)?.message || 'Ошибка');
            this.safeCloseMenus();
          } finally {
            processed++;
            this.selected.delete(it.id);

            const rowLive = this.findRowByHref(it.href);
            const cb = rowLive?.querySelector<HTMLInputElement>('.cbm-checkbox');
            if (cb) cb.checked = false;

            this.setStatus(`Удаление… ${processed}/${total}${fail ? ` (ошибок ${fail})` : ''}`);
            this.setProgress(processed, total);
            this.updateBar();

            await this.idleOrSleep(this.opts.staggerMs);
          }
        }
      };

      await Promise.all(Array.from({ length: this.opts.concurrency }, () => worker()));

      this.setStatus(`Готово: ${ok}/${total}${fail ? `, ошибок ${fail}` : ''}`);
      await this.waitSidebarReady();
      this.attachCheckboxes();
      this.updateBar();
    } finally {
      document.documentElement.removeAttribute('data-cbm-stealth');
      this.showLoader(false);
      this.actionBar?.classList.remove('running');
      setTimeout(() => {
        this.setStatus('');
        this.setProgress(0, 0);
        this.updateBar();
      }, 500);
    }
  }

  /* ===================================================================================
   *                                     UI actions
   * =================================================================================== */

  /**
   * Полный сценарий удаления одного чата через UI:
   *  - найти строку
   *  - открыть меню
   *  - клик «Удалить»
   *  - подтвердить в диалоге
   *  - дождаться исчезновения строки
   */
  private async deleteViaUI(href: string): Promise<void> {
    const row = await this.waitFor(() => this.findRowByHref(href), 3000).catch(() => null);
    if (!row) throw new Error('Строка чата не найдена (E_ROW)');

    const btn = await this.waitFor(() => this.findOptionsButton(row), 1500).catch(() => null);
    if (!btn) throw new Error('Кнопка опций не найдена (E_BTN)');

    await this.scrollIntoViewSmart(row);
    this.hover(row);
    await this.openMenu(btn);

    const del = await this.waitFor(() => this.findDeleteMenuItem(), this.opts.maxMenuWaitMs).catch(() => null);
    if (!del) throw new Error('Пункт «Удалить» не найден (E_MENUITEM)');
    await this.realClick(del);

    const confirm = await this.waitFor(() => this.findConfirmButton(), this.opts.maxDialogWaitMs).catch(() => null);
    if (!confirm) throw new Error('Не найдено подтверждение удаления (E_CONFIRM)');
    await this.realClick(confirm);

    await this.waitFor(() => !this.findRowByHref(href), 8000);
    await this.sleep(this.opts.afterDeleteWaitMs);
    this.safeCloseMenus();
  }

  /**
   * Находим кнопку «три точки» / options в строке
   */
  private findOptionsButton(row: Element): HTMLButtonElement | null {
    if (!row) return null;
    return (
        row.querySelector<HTMLButtonElement>('button.__menu-item-trailing-btn[data-testid$="options"]') ||
        row.querySelector<HTMLButtonElement>('.trailing .__menu-item-trailing-btn') ||
        row.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]') ||
        [...Array.from(row.querySelectorAll<HTMLButtonElement>('button'))].pop() ||
        null
    );
  }

  /**
   * Ищем пункт меню «Удалить» разными способами (testid, fallback по тексту)
   */
  private findDeleteMenuItem(): HTMLElement | null {
    return (
        document.querySelector<HTMLElement>('div[data-testid="delete-chat-menu-item"]') ||
        [...Array.from(document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"], [role="menu"] button'))]
            .find(n => /удалить|delete/i.test(n.textContent || '')) ||
        null
    );
  }

  /**
   * Ищем кнопку подтверждения удаления (в диалоге)
   */
  private findConfirmButton(): HTMLButtonElement | null {
    return (
        document.querySelector<HTMLButtonElement>('[data-testid="delete-conversation-confirm-button"]') ||
        [...Array.from((document.querySelector('[role="dialog"],[role="alertdialog"]')?.querySelectorAll('button') || []))]
            .find(b => /удалить|delete/i.test(b.textContent || '')) as HTMLButtonElement ||
        document.querySelector<HTMLButtonElement>('button.btn-danger') ||
        null
    );
  }

  /* ===================================================================================
   *                                  low-level events
   * =================================================================================== */

  /**
   * Аккуратно открываем связанное Radix-меню: пытаемся много раз,
   * между попытками — маленькая пауза.
   */
  private async openMenu(btn: HTMLElement): Promise<void> {
    const id = (btn as HTMLElement).id || ((btn as HTMLElement).id = `cbm-btn-${Math.random().toString(36).slice(2)}`);

    for (let i = 0; i < this.opts.clickRetries; i++) {
      await this.scrollIntoViewSmart(btn);
      await this.realClick(btn);

      try {
        const menu = await this.waitFor(
            () =>
                document.querySelector<HTMLElement>(`[role="menu"][aria-labelledby="${CSS.escape(id)}"]`) ||
                document.querySelector<HTMLElement>('[role="menu"][data-state="open"]'),
            250
        );
        if (menu) return;
      } catch {
        /* ignore */
      }

      await this.sleep(this.opts.clickRetryDelay);
    }

    const any = document.querySelector('[role="menu"][data-state="open"]');
    if (any) return;

    throw new Error('Меню не открылось вовремя (E_MENU)');
  }

  /**
   * «Реальный» клик: сначала пробуем .click(), если элемент слушает
   * mouse/pointer — шлём синтетическую последовательность событий.
   */
  private async realClick(el: Element | null): Promise<void> {
    if (!el) return;

    const domClick = () => { try { (el as HTMLElement).click?.(); } catch { /* ignore */ } };
    if (typeof (el as any).dispatchEvent !== 'function') { domClick(); return; }

    await this.scrollIntoViewSmart(el);
    const rect = (el as HTMLElement).getBoundingClientRect?.();
    if (!rect || rect.width === 0 || rect.height === 0) { domClick(); return; }

    const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
    const cx = clamp(rect.left + Math.min(rect.width - 2, Math.max(2, rect.width / 2)), 0, (window.innerWidth || 1) - 1);
    const cy = clamp(rect.top  + Math.min(rect.height - 2, Math.max(2, rect.height / 2)), 0, (window.innerHeight || 1) - 1);

    let targetAtPoint: Element | null = null;
    try { targetAtPoint = document.elementFromPoint(cx, cy); } catch { /* ignore */ }
    const target = (targetAtPoint && (el.contains(targetAtPoint) ? targetAtPoint : el)) || el;

    const mk = (type: string, extra: MouseEventInit = {}) =>
        new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: cx, clientY: cy, button: 0, buttons: 1, ...extra });

    const pe = (type: string, extra: PointerEventInit = {}) =>
        new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, clientX: cx, clientY: cy, button: 0, buttons: 1, ...extra });

    try {
      target.dispatchEvent(pe('pointerover'));
      target.dispatchEvent(mk('mouseover'));
      target.dispatchEvent(pe('pointerenter'));
      target.dispatchEvent(mk('mouseenter'));
      target.dispatchEvent(pe('pointerdown'));
      target.dispatchEvent(mk('mousedown'));
      (target as HTMLElement).focus?.();
      target.dispatchEvent(pe('pointerup', { buttons: 0 }));
      target.dispatchEvent(mk('mouseup', { buttons: 0 }));
      target.dispatchEvent(mk('click', { buttons: 0 }));
    } catch {
      domClick();
    }
  }

  /**
   * Лёгкий hover — может подсветить строку и показать иконку опций
   */
  private hover(el: Element | null): void {
    if (!el) return;
    ['pointerover', 'mouseover', 'mouseenter']
        .forEach(t => el.dispatchEvent(new MouseEvent(t, { bubbles: true, composed: true })));
  }

  /**
   * Аккуратная прокрутка элемента в видимую область, учитывая контейнер сайдбара
   */
  private async scrollIntoViewSmart(el: Element): Promise<void> {
    if (!el) return;
    const sidebar = this.findSidebar();
    const scrollable =
        sidebar?.querySelector<HTMLElement>('[data-overlaysscrollbars-viewport]') ||
        sidebar?.querySelector<HTMLElement>('[data-overlaysscrollbars]') ||
        sidebar ||
        document.scrollingElement ||
        document.documentElement;

    const r = (el as HTMLElement).getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight;

    if (r.top < 60 || r.bottom > vh - 60) {
      (el as HTMLElement).scrollIntoView({ block: 'center', inline: 'nearest' });
      if ((scrollable as any)?.scrollBy) {
        const rr = (el as HTMLElement).getBoundingClientRect();
        const delta = rr.top - vh / 2;
        (scrollable as HTMLElement).scrollBy({ top: delta });
      }
      await this.sleep(24);
    }
  }

  /* ===================================================================================
   *                                    waiters & misc
   * =================================================================================== */

  /**
   * Пуллинг-функция ожидания результата коллбэка до таймаута
   */
  private waitFor<T>(fn: () => T | null | undefined, timeout = 2000, step = 45): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t0 = performance.now();
      const loop = () => {
        let res: T | null | undefined = null;
        try { res = fn() as T; } catch { /* ignore */ }
        if (res) return resolve(res);
        if (performance.now() - t0 > timeout) return reject(new Error('Таймаут ожидания'));
        setTimeout(loop, step);
      };
      loop();
    });
  }

  /**
   * Ожидаем, что сайдбар готов (появились строки с /c/…)
   */
  private async waitSidebarReady(timeout = 3500): Promise<void> {
    const t0 = performance.now();
    const ok = () => (this.findSidebar() || document).querySelector('a.group.__menu-item.hoverable[href*="/c/"]');
    while (performance.now() - t0 <= timeout) {
      if (ok()) return;
      await this.sleep(50);
    }
  }

  /**
   * Мягкое закрытие открытых меню/диалогов
   */
  private safeCloseMenus(): void {
    const openMenu = document.querySelector('[role="menu"][data-state="open"]');
    if (openMenu) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    const dialogBtn = document.querySelector<HTMLButtonElement>('[data-testid="delete-conversation-confirm-button"]');
    if (dialogBtn) {
      const cancel = dialogBtn.closest('[role="dialog"],[role="alertdialog"]')?.querySelector<HTMLButtonElement>('button.btn-secondary,button');
      cancel?.click?.();
    }
  }

  /**
   * Показ/скрытие «спиннера» в панели
   */
  private showLoader(show: boolean): void {
    const el = this.actionBar?.querySelector<HTMLElement>('.cbm-loader');
    if (!el) return;
    el.hidden = !show;
  }

  /**
   * Текстовый статус в панели
   */
  private setStatus(text: string): void {
    const el = this.actionBar?.querySelector<HTMLElement>('.cbm-status');
    if (el) el.textContent = text || '';
  }

  /**
   * Обновить бейдж прогресса
   */
  private setProgress(processed: number, total: number): void {
    const pill = this.actionBar?.querySelector<HTMLElement>('.cbm-progress-pill');
    if (!pill) return;
    if (!total) {
      pill.hidden = true;
      pill.textContent = '0/0';
    } else {
      pill.hidden = false;
      pill.textContent = `${processed}/${total}`;
    }
  }

  /**
   * Короткое сообщение об ошибке (мигает и исчезает)
   */
  private flashError(msg: string, ms = 1200): void {
    const el = this.actionBar?.querySelector<HTMLElement>('.cbm-status');
    if (!el) return;
    const prev = el.textContent || '';
    el.textContent = `⚠ ${msg}`;
    setTimeout(() => { if (el.textContent?.startsWith('⚠')) el.textContent = prev; }, ms);
  }

  /** Простой sleep */
  private sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }

  /** Спим или ждём idle (если доступно) */
  private idleOrSleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      // @ts-ignore
      if ('requestIdleCallback' in window) (window as any).requestIdleCallback(() => resolve(), { timeout: ms });
      else setTimeout(resolve, ms);
    });
  }
}

/* =====================================================================================
 *                                        MODULE
 * ===================================================================================== */

let manager: ChatBulkUI | null = null;

/**
 * Инициализация модуля (вызывается фреймворком)
 */
export async function init(_ctx: ModuleCtx): Promise<void> {
  manager = new ChatBulkUI({
    enabled: true,
    stealth: true,
    concurrency: 2,
    staggerMs: 50
  });
  manager.start();
}

/**
 * Остановка модуля: снимаем чекбоксы и чистим состояние
 */
export async function stop(_ctx: ModuleCtx): Promise<void> {
  manager?.detach();
  manager = null;
}

/**
 * Экспорт описания модуля
 */
export const moduleDef: Module = { id, order, init, stop };
export default moduleDef;