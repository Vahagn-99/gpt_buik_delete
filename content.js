(() => {
    class ChatBulkUI {
        constructor({
                        enabled = true,
                        stealth = true,
                        concurrency = 2,
                        staggerMs = 50,
                        maxMenuWaitMs = 3500,
                        maxDialogWaitMs = 7000,
                        clickRetries = 8,
                        clickRetryDelay = 140,
                        afterDeleteWaitMs = 140
                    } = {}) {
            this.enabled = enabled;
            this.stealth = stealth;
            this.concurrency = Math.max(1, Math.min(4, concurrency));
            this.staggerMs = staggerMs;
            this.maxMenuWaitMs = maxMenuWaitMs;
            this.maxDialogWaitMs = maxDialogWaitMs;
            this.clickRetries = clickRetries;
            this.clickRetryDelay = clickRetryDelay;
            this.afterDeleteWaitMs = afterDeleteWaitMs;

            this.selected = new Map(); // id -> { href }
            this.actionBar = null;
            this.obs = null;
        }

        // ===== lifecycle
        start() {
            if (!this.enabled) {
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

        detach() {
            document.querySelectorAll('.cbm-checkbox').forEach(el => el.remove());
            this.selected.clear();
        }

        // ===== helpers: URL/DOM
        normalizePath(href) {
            try {
                const u = new URL(href, location.origin);
                return u.pathname.replace(/\/+$/, ''); // без trailing slash
            } catch {
                return (href || '').split('?')[0].replace(/\/+$/, '');
            }
        }
        // ВАЖНО: поддерживаем /c/<uuid> как в /c/... так и в /g/.../c/...
        extractIdFromHref(href) {
            if (!href) return null;
            const path = this.normalizePath(href);
            const m = path.match(/\/c\/([a-z0-9-]+)(?:\/)?$/i);
            return m ? m[1] : null;
        }
        findSidebar() {
            return document.querySelector('[data-testid="nav"]');
        }
        findRowByHref(href) {
            const targetPath = this.normalizePath(href);
            const scope = this.findSidebar() || document;
            const all = scope.querySelectorAll('a.group.__menu-item.hoverable[href*="/c/"]');
            for (const a of all) {
                try {
                    if (this.normalizePath(a.href) === targetPath) return a;
                } catch {}
            }
            return null;
        }

        // ===== checkboxes
        attachCheckboxes() {
            if (!this.enabled) return;
            const sidebar = this.findSidebar() || document;
            // Берём ВСЕ элементы с /c/ в href (покрывает /g/.../c/...)
            const rows = sidebar.querySelectorAll('a.group.__menu-item.hoverable[href*="/c/"]');
            rows.forEach((row) => {
                if (row.querySelector('.cbm-checkbox')) return;

                const href = row.getAttribute('href');
                const id = this.extractIdFromHref(href);
                if (!id || !href) return;

                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.className = 'cbm-checkbox';

                const stop = (e) => { e.stopPropagation(); e.stopImmediatePropagation(); };
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

        // ===== action bar (anchored to sidebar)
        renderBar() {
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

            // пробуем закрепить в сайдбар
            const sidebar = this.findSidebar();
            if (sidebar) {
                const host = sidebar.querySelector('[data-overlaysscrollbars-viewport]') || sidebar;
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
                });
            }

            bar.querySelector('.cbm-clear').addEventListener('click', () => this.clearSelection());
            bar.querySelector('.cbm-del').addEventListener('click', () => this.runBulkDelete());
            bar.querySelector('.cbm-select-all').addEventListener('click', () => this.selectAll());

            this.actionBar = bar;
        }

        updateBar() {
            if (!this.actionBar) return;
            const n = this.selected.size;
            const running = this.actionBar.classList.contains('running');

            const countEl = this.actionBar.querySelector('.cbm-count');
            if (countEl) countEl.textContent = String(n);

            const shouldShow = running || n > 0;
            this.actionBar.classList.toggle('cbm-hidden', !shouldShow);

            const delBtn = this.actionBar.querySelector('.cbm-del');
            if (delBtn) delBtn.disabled = !this.enabled || n === 0 || running;

            const clr = this.actionBar.querySelector('.cbm-clear');
            if (clr) clr.disabled = (n === 0 || running);

            const selAll = this.actionBar.querySelector('.cbm-select-all');
            if (selAll) selAll.disabled = running;
        }

        clearSelection() {
            document.querySelectorAll('.cbm-checkbox:checked').forEach(cb => (cb.checked = false));
            this.selected.clear();
            this.updateBar();
        }

        selectAll() {
            const sidebar = this.findSidebar() || document;
            const rows = sidebar.querySelectorAll('a.group.__menu-item.hoverable[href*="/c/"]');
            let any = 0;
            rows.forEach(row => {
                const href = row.getAttribute('href');
                const id = this.extractIdFromHref(href);
                if (!id || !href) return;
                let cb = row.querySelector('.cbm-checkbox');
                if (!cb) { this.attachCheckboxes(); cb = row.querySelector('.cbm-checkbox'); }
                if (cb && !cb.checked) { cb.checked = true; any++; }
                this.selected.set(id, { href });
            });
            this.updateBar();
            if (!any) this.flashError('Нечего выбирать', 900);
        }

        bindGlobal() {
            if (this.obs) this.obs.disconnect();
            this.obs = new MutationObserver(() => {
                if (this.enabled) this.attachCheckboxes();
            });
            this.obs.observe(document.body, { subtree: true, childList: true });
        }

        // ===== navigation guard
        async ensureNotOnSelected(items) {
            const selectedPaths = new Set(items.map(it => this.normalizePath(it.href)));
            const here = this.normalizePath(location.href);
            if (!selectedPaths.has(here)) return;

            const newBtn = document.querySelector('[data-testid="new-chat-button"]');
            if (newBtn) { try { newBtn.click(); } catch {} await this.waitSidebarReady(4000); return; }

            try { history.pushState(null, '', '/'); window.dispatchEvent(new PopStateEvent('popstate')); }
            catch { try { location.assign('/'); } catch {} }
            await this.waitSidebarReady(4000);
        }

        // ===== bulk delete
        async runBulkDelete() {
            if (!this.enabled) return;
            const items = [...this.selected.entries()].map(([id, ctx]) => ({ id, href: ctx.href }));
            if (!items.length) return;

            await this.ensureNotOnSelected(items);

            let processed = 0, ok = 0, fail = 0;
            const total = items.length;

            this.actionBar.classList.add('running');
            this.showLoader(true);
            this.setProgress(processed, total);
            this.setStatus(`Удаление… ${processed}/${total}`);
            this.updateBar();

            if (this.stealth) document.documentElement.setAttribute('data-cbm-stealth', '');

            try {
                let i = 0;
                const worker = async () => {
                    while (i < items.length) {
                        const it = items[i++];

                        try {
                            await this.deleteViaUI(it.href);
                            ok++;
                        } catch (e) {
                            fail++;
                            console.warn('[cbm] E_DELETE', it.id, e);
                            this.flashError(e?.message || 'Ошибка');
                            this.safeCloseMenus();
                        } finally {
                            processed++;
                            this.selected.delete(it.id);

                            const rowLive = this.findRowByHref(it.href);
                            const cb = rowLive?.querySelector('.cbm-checkbox');
                            if (cb) cb.checked = false;

                            this.setStatus(`Удаление… ${processed}/${total}${fail ? ` (ошибок ${fail})` : ''}`);
                            this.setProgress(processed, total);
                            this.updateBar();

                            await this.idleOrSleep(this.staggerMs);
                        }
                    }
                };

                await Promise.all(Array.from({ length: this.concurrency }, () => worker()));

                this.setStatus(`Готово: ${ok}/${total}${fail ? `, ошибок ${fail}` : ''}`);
                await this.waitSidebarReady();
                this.attachCheckboxes();
                this.updateBar();
            } finally {
                document.documentElement.removeAttribute('data-cbm-stealth');
                this.showLoader(false);
                this.actionBar.classList.remove('running');
                setTimeout(() => { this.setStatus(''); this.setProgress(0, 0); this.updateBar(); }, 500);
            }
        }

        // ===== UI actions
        async deleteViaUI(href) {
            const row = await this.waitFor(() => this.findRowByHref(href), 3000).catch(() => null);
            if (!row) { throw new Error('Строка чата не найдена (E_ROW)'); }

            const btn = await this.waitFor(() => this.findOptionsButton(row), 1500).catch(() => null);
            if (!btn) { throw new Error('Кнопка опций не найдена (E_BTN)'); }

            await this.scrollIntoViewSmart(row);
            this.hover(row);
            await this.openMenu(btn);

            const del = await this.waitFor(() => this.findDeleteMenuItem(), this.maxMenuWaitMs).catch(() => null);
            if (!del) { throw new Error('Пункт «Удалить» не найден (E_MENUITEM)'); }
            await this.realClick(del);

            const confirm = await this.waitFor(() => this.findConfirmButton(), this.maxDialogWaitMs).catch(() => null);
            if (!confirm) { throw new Error('Не найдено подтверждение удаления (E_CONFIRM)'); }
            await this.realClick(confirm);

            await this.waitFor(() => !this.findRowByHref(href), 8000);
            await this.sleep(this.afterDeleteWaitMs);
            this.safeCloseMenus();
        }

        findOptionsButton(row) {
            if (!row) return null;
            return (
                row.querySelector('button.__menu-item-trailing-btn[data-testid$="options"]') ||
                row.querySelector('.trailing .__menu-item-trailing-btn') ||
                row.querySelector('button[aria-haspopup="menu"]') ||
                [...row.querySelectorAll('button')].pop() ||
                null
            );
        }
        findDeleteMenuItem() {
            return (
                document.querySelector('div[data-testid="delete-chat-menu-item"]') ||
                [...document.querySelectorAll('[role="menu"] [role="menuitem"], [role="menu"] button')]
                    .find(n => /удалить|delete/i.test(n.textContent || '')) ||
                null
            );
        }
        findConfirmButton() {
            return (
                document.querySelector('[data-testid="delete-conversation-confirm-button"]') ||
                [...(document.querySelector('[role="dialog"],[role="alertdialog"]')?.querySelectorAll('button') || [])]
                    .find(b => /удалить|delete/i.test(b.textContent || '')) ||
                document.querySelector('button.btn-danger') ||
                null
            );
        }

        // ===== low-level events
        async openMenu(btn) {
            const id = btn.id || (btn.id = `cbm-btn-${Math.random().toString(36).slice(2)}`);
            for (let i = 0; i < this.clickRetries; i++) {
                await this.scrollIntoViewSmart(btn);
                await this.realClick(btn);
                try {
                    const menu = await this.waitFor(
                        () =>
                            document.querySelector(`[role="menu"][aria-labelledby="${CSS.escape(id)}"]`) ||
                            document.querySelector('[role="menu"][data-state="open"]'),
                        250
                    );
                    if (menu) return;
                } catch {}
                await this.sleep(this.clickRetryDelay);
            }
            const any = document.querySelector('[role="menu"][data-state="open"]');
            if (any) return;
            throw new Error('Меню не открылось вовремя (E_MENU)');
        }

        async realClick(el) {
            if (!el) return;
            const domClick = () => { try { el.click?.(); } catch {} };
            if (typeof el.dispatchEvent !== 'function') { domClick(); return; }

            await this.scrollIntoViewSmart(el);
            const rect = el.getBoundingClientRect();
            if (!rect || rect.width === 0 || rect.height === 0) { domClick(); return; }

            const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
            const cx = clamp(rect.left + Math.min(rect.width - 2, Math.max(2, rect.width / 2)), 0, (window.innerWidth || 1) - 1);
            const cy = clamp(rect.top  + Math.min(rect.height - 2, Math.max(2, rect.height / 2)), 0, (window.innerHeight || 1) - 1);

            let targetAtPoint = null;
            try { targetAtPoint = document.elementFromPoint(cx, cy); } catch {}
            const target = (targetAtPoint && (el.contains(targetAtPoint) ? targetAtPoint : el)) || el;

            const mk = (type, extra = {}) => new MouseEvent(type, {
                bubbles: true, cancelable: true, composed: true,
                clientX: cx, clientY: cy, screenX: cx, screenY: cy,
                button: 0, buttons: 1, ...extra
            });
            const pe = (type, extra = {}) => new PointerEvent(type, {
                bubbles: true, cancelable: true, composed: true,
                pointerId: 1, pointerType: 'mouse', isPrimary: true,
                clientX: cx, clientY: cy, button: 0, buttons: 1, ...extra
            });

            try {
                target.dispatchEvent(pe('pointerover'));
                target.dispatchEvent(mk('mouseover'));
                target.dispatchEvent(pe('pointerenter'));
                target.dispatchEvent(mk('mouseenter'));
                target.dispatchEvent(pe('pointerdown'));
                target.dispatchEvent(mk('mousedown'));
                if (typeof target.focus === 'function') target.focus();
                target.dispatchEvent(pe('pointerup', { buttons: 0 }));
                target.dispatchEvent(mk('mouseup', { buttons: 0 }));
                target.dispatchEvent(mk('click', { buttons: 0 }));
            } catch { domClick(); }
        }

        hover(el) {
            if (!el) return;
            ['pointerover','mouseover','mouseenter']
                .forEach(t => el.dispatchEvent(new MouseEvent(t, { bubbles: true, composed: true })));
        }

        async scrollIntoViewSmart(el) {
            if (!el) return;
            const sidebar = this.findSidebar();
            const scrollable = sidebar?.querySelector('[data-overlaysscrollbars-viewport]') ||
                sidebar?.querySelector('[data-overlaysscrollbars]') ||
                sidebar || document.scrollingElement || document.documentElement;

            const r = el.getBoundingClientRect();
            const vh = window.innerHeight || document.documentElement.clientHeight;

            if (r.top < 60 || r.bottom > vh - 60) {
                el.scrollIntoView({ block: 'center', inline: 'nearest' });
                if (scrollable?.scrollBy) {
                    const rr = el.getBoundingClientRect();
                    const delta = rr.top - vh / 2;
                    scrollable.scrollBy({ top: delta });
                }
                await this.sleep(24);
            }
        }

        // ===== waiters & misc
        waitFor(fn, timeout = 2000, step = 45) {
            return new Promise((resolve, reject) => {
                const t0 = performance.now();
                const loop = () => {
                    let res = null;
                    try { res = fn(); } catch {}
                    if (res) return resolve(res);
                    if (performance.now() - t0 > timeout) return reject(new Error('Таймаут ожидания'));
                    setTimeout(loop, step);
                };
                loop();
            });
        }
        async waitSidebarReady(timeout = 3500) {
            const t0 = performance.now();
            const ok = () => (this.findSidebar() || document).querySelector('a.group.__menu-item.hoverable[href*="/c/"]');
            while (performance.now() - t0 <= timeout) { if (ok()) return; await this.sleep(50); }
        }

        safeCloseMenus() {
            const openMenu = document.querySelector('[role="menu"][data-state="open"]');
            if (openMenu) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            const dialogBtn = document.querySelector('[data-testid="delete-conversation-confirm-button"]');
            if (dialogBtn) {
                const cancel = dialogBtn.closest('[role="dialog"],[role="alertdialog"]')?.querySelector('button.btn-secondary,button');
                cancel?.click?.();
            }
        }

        showLoader(show) {
            const el = this.actionBar?.querySelector('.cbm-loader');
            if (!el) return;
            el.hidden = !show;
        }
        setStatus(text) {
            const el = this.actionBar?.querySelector('.cbm-status');
            if (el) el.textContent = text || '';
        }
        setProgress(processed, total) {
            const pill = this.actionBar?.querySelector('.cbm-progress-pill'); if (!pill) return;
            if (!total) { pill.hidden = true; pill.textContent = '0/0'; }
            else { pill.hidden = false; pill.textContent = `${processed}/${total}`; }
        }
        flashError(msg, ms = 1200) {
            const el = this.actionBar?.querySelector('.cbm-status'); if (!el) return;
            const prev = el.textContent; el.textContent = `⚠ ${msg}`;
            setTimeout(() => { if (el.textContent?.startsWith('⚠')) el.textContent = prev; }, ms);
        }
        sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
        idleOrSleep(ms) { return new Promise((resolve) => { if ('requestIdleCallback' in window) window.requestIdleCallback(() => resolve(), { timeout: ms }); else setTimeout(resolve, ms); }); }
    }

    // ==== init ====
    const manager = new ChatBulkUI({
        enabled: true,
        stealth: true,
        concurrency: 2, // подними до 3, если стабильно
        staggerMs: 50
    });
    manager.start();
})();