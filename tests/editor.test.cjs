// Run with: node --test tests/editor.test.cjs
// Exercise the actual inline event handlers in a minimal, in-memory DOM.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
// Synthetic 4 × 4 grid; no private mask files are needed.
const fixture = JSON.stringify({
  format: 'copper-mask-studio', version: 4, name: 'Test mask',
  width: 10, height: 10, pitch: 2.5, cols: 4, rows: 4,
  bits: Buffer.from([0x81, 0x18]).toString('base64'),
});
const storageKey = 'copper-mask-studio-v1';

function boot(saved) {
  const elements = [], byId = {}, listeners = {}, windowListeners = {}, timers = new Map();
  const storage = new Map(saved ? [[storageKey, saved]] : []);
  let reads = 0, writes = 0, sequence = 0;
  class Element {
    constructor(tag, attrs = '') {
      this.tagName = tag.toUpperCase();
      this.attrs = Object.fromEntries([...attrs.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map(m => [m[1], m[2] ?? '']));
      this.value = this.attrs.value ?? '';
      this.id = this.attrs.id;
      this.hidden = 'hidden' in this.attrs;
      this.disabled = 'disabled' in this.attrs;
      this.checked = 'checked' in this.attrs;
      this.dataset = {tool: this.attrs['data-tool']};
      this.style = {};
      this.events = {};
      this.textContent = '';
      this.open = false;
      const classes = new Set((this.attrs.class || '').split(' '));
      this.classList = {
        add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c),
        toggle: (c, on) => { on ??= !classes.has(c); on ? classes.add(c) : classes.delete(c); },
      };
    }
    addEventListener(name, fn) { (this.events[name] ??= []).push(fn); }
    dispatch(name, event = {}) {
      event.target ??= this;
      event.preventDefault ??= () => { event.defaultPrevented = true; };
      for (const fn of this.events[name] || []) fn(event);
      return event;
    }
    click() { if (!this.disabled) { this.onclick?.(); this.dispatch('click'); } }
    setAttribute(name, value) { this.attrs[name] = value; }
    showModal() { this.open = true; }
    close() { this.open = false; }
    focus() { document.activeElement = this; }
    append(child) { child.parent = this; }
    remove() {}
    closest(tag) { let el = this; while (el && el.tagName !== tag.toUpperCase()) el = el.parent; return el; }
    getBoundingClientRect() { return {left: 0, top: 0, width: 900, height: 600}; }
    getContext() { return new Proxy({}, {get: () => () => {}}); }
    setPointerCapture() {}
  }
  const parents = [];
  for (const m of html.split('<script')[0].matchAll(/<(\/?)([\w-]+)([^>]*)>/g)) {
    if (m[1]) { while (parents.length && parents.pop().tagName !== m[2].toUpperCase()) {} continue; }
    const el = new Element(m[2], m[3]);
    el.parent = parents.at(-1);
    elements.push(el);
    if (el.id) byId[el.id] = el;
    if (!/^(meta|input|br|hr|img|link)$/i.test(m[2])) parents.push(el);
  }
  const document = {
    body: elements.find(e => e.tagName === 'BODY'),
    getElementById: id => byId[id],
    querySelectorAll: selector => elements.filter(e => selector === '[data-tool]' ? e.dataset.tool : selector === '[data-close]' ? 'data-close' in e.attrs : selector === 'dialog[open]' ? e.tagName === 'DIALOG' && e.open : false),
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    addEventListener: (name, fn) => { (listeners[name] ??= []).push(fn); },
    createElement: tag => new Element(tag),
  };
  const context = vm.createContext({
    document, window: {addEventListener: (name, fn) => { (windowListeners[name] ??= []).push(fn); }},
    localStorage: {getItem: key => { reads++; return storage.get(key) ?? null; }, setItem: (key, value) => { writes++; storage.set(key, value); }},
    setTimeout: fn => { timers.set(++sequence, fn); return sequence; }, clearTimeout: id => timers.delete(id),
    requestAnimationFrame: () => {}, ResizeObserver: class { observe() {} }, devicePixelRatio: 1,
    TextEncoder, Blob, URL, btoa, atob, console,
  });
  scripts.forEach(script => vm.runInContext(script, context));
  return {
    el: byId, context, storage, document, get reads() { return reads; }, get writes() { return writes; },
    key(key, extra = {}) {
      const event = {key, target: byId.board, preventDefault() { this.defaultPrevented = true; }, ...extra};
      for (const fn of listeners.keydown || []) fn(event);
      return event;
    },
    unload() { for (const fn of windowListeners.beforeunload || []) fn(); },
    flush() { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); },
    create(w = 10, h = 10, pitch = 1) {
      byId['choose-new'].click();
      byId.width.value = String(w); byId.height.value = String(h); byId.pitch.value = String(pitch);
      byId.width.dispatch('input'); byId.create.click();
    },
  };
}

test('startup requires an explicit choice; Escape and unload do not load or overwrite stored data', () => {
  const app = boot(fixture);
  assert.equal(app.el['start-dialog'].open, true);
  assert.equal(app.el['editor-app'].hidden, true);
  assert.equal(app.el['new-form'].hidden, true);
  assert.equal(app.el.save.disabled, true);
  assert.equal(app.el['start-dialog'].dispatch('cancel').defaultPrevented, true);
  app.key('b'); app.unload(); app.flush();
  assert.equal(app.reads, 0); assert.equal(app.writes, 0);
  assert.equal(app.storage.get(storageKey), fixture);
});

test('new document fixes dimensions; keyboard fills only the selected range and supports undo/redo', () => {
  const app = boot(); app.create();
  assert.equal(app.el['start-dialog'].open, false);
  assert.equal(app.el['editor-app'].hidden, false);
  assert.match(app.el['project-settings'].textContent, /全体 10 × 10 mm/);
  for (const id of ['width', 'height', 'pitch']) assert.equal(app.el[id].closest('dialog'), app.el['start-dialog']);
  app.el['range-input'].click();
  for (const [id, value] of Object.entries({'range-x1': 2, 'range-y1': 3, 'range-x2': 4, 'range-y2': 4})) app.el[id].value = value;
  app.el['range-apply'].click();
  app.key('B'); assert.equal(app.el['black-count'].textContent, '6');
  app.key('E'); assert.equal(app.el['black-count'].textContent, '0');
  app.key('T'); assert.equal(app.el['black-count'].textContent, '6');
  app.key('t', {repeat: true}); assert.equal(app.el['black-count'].textContent, '6');
  app.key('t'); assert.equal(app.el['black-count'].textContent, '0');
  app.key('z', {ctrlKey: true}); assert.equal(app.el['black-count'].textContent, '6');
  app.key('z', {metaKey: true, shiftKey: true}); assert.equal(app.el['black-count'].textContent, '0');
  app.key('a', {ctrlKey: true}); app.key('b'); app.flush();
  const data = JSON.parse(app.storage.get(storageKey));
  assert.deepEqual([data.width, data.height, data.pitch], [10, 10, 1]);
  assert.equal(app.el['black-count'].textContent, '100');
  assert.equal(app.el.invert.disabled, false);
});

test('shortcuts respect typing, composition, modifiers and dialogs; no selection switches tools', () => {
  const app = boot(); app.create(); app.el['select-all'].click();
  for (const extra of [{target: app.el.name}, {target: {tagName: 'DIV', isContentEditable: true}}, {isComposing: true}, {altKey: true}, {ctrlKey: true}, {metaKey: true}]) app.key('b', extra);
  assert.equal(app.el['black-count'].textContent, '0');
  app.el['range-input'].click(); app.key('b'); assert.equal(app.el['black-count'].textContent, '0');
  app.el['range-dialog'].close(); app.key('b'); assert.equal(app.el['black-count'].textContent, '100');
  app.key('Escape'); app.key('e');
  const whiteTool = app.document.querySelectorAll('[data-tool]').find(e => e.dataset.tool === 'white');
  assert.equal(whiteTool.attrs['aria-pressed'], 'true');
  assert.equal(app.el['black-count'].textContent, '100');
});

test('explicit restore opens saved data, while a subsequent startup stays empty', () => {
  const app = boot(fixture); app.el.restore.click();
  assert.equal(app.reads, 1);
  assert.equal(app.el['start-dialog'].open, false);
  assert.equal(app.el.name.value, JSON.parse(fixture).name);
  assert.ok(Number(app.el['black-count'].textContent.replaceAll(',', '')) > 0);
  app.flush();
  const next = boot(app.storage.get(storageKey));
  assert.equal(next.reads, 0); assert.equal(next.el['editor-app'].hidden, true);
});

test('file import works and switching documents resets history without changing the current dimensions on cancel', async () => {
  const app = boot();
  app.el.file.files = [{size: fixture.length, text: async () => fixture}];
  await app.el.file.onchange();
  assert.equal(app.el['start-dialog'].open, false);
  const before = app.el['project-settings'].textContent;
  app.el['select-all'].click(); app.key('e');
  app.el.new.click(); app.create(20, 30, 2);
  assert.equal(app.el['replace-dialog'].open, true);
  assert.equal(app.el['project-settings'].textContent, before);
  app.el['replace-dialog'].close(); app.el['start-cancel'].click();
  assert.equal(app.el['start-dialog'].open, false);
  assert.equal(app.el['project-settings'].textContent, before);
  app.el.new.click(); app.create(20, 30, 2); app.el['replace-apply'].click();
  assert.equal(app.el['start-dialog'].open, false);
  assert.match(app.el['project-settings'].textContent, /全体 20 × 30 mm/);
  assert.equal(app.el.undo.disabled, true); assert.equal(app.el.redo.disabled, true);
  app.key('z', {ctrlKey: true}); assert.match(app.el['project-settings'].textContent, /全体 20 × 30 mm/);
});

test('invalid dimensions, invalid files and missing or corrupt stored data leave startup usable', async () => {
  const app = boot(); app.create(0);
  assert.equal(app.el.create.disabled, true);
  assert.equal(app.el['editor-app'].hidden, true);
  app.el.restore.click();
  assert.match(app.el.toast.textContent, /保存データがありません/);
  assert.equal(app.el.toast.parent, app.el['start-dialog']);
  app.el.file.files = [{size: 5, text: async () => '{bad}'}];
  await app.el.file.onchange();
  assert.match(app.el.toast.textContent, /JSON形式/);
  assert.equal(app.el['start-dialog'].open, true);
  app.storage.set(storageKey, '{bad}'); app.el.restore.click();
  assert.equal(app.el['editor-app'].hidden, true);
  app.create(); assert.equal(app.el['start-dialog'].open, false);
});
