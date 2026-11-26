const app = document.querySelector("#app");

const state = {
  library: null,
  doc: null,
  mode: "read",
  query: "",
  error: "",
  busy: false,
  sorts: {},
  focusBlock: null,
  selectedId: null,
};

let shellFor = null;
let observer = null;

window.addEventListener("hashchange", route);
route();

async function route() {
  const id = location.hash.startsWith("#/doc/")
    ? decodeURIComponent(location.hash.slice(6))
    : "";
  if (!id) {
    state.doc = null;
    shellFor = null;
    await showHome();
    return;
  }
  if (!state.doc || state.doc.id !== id) {
    await openDoc(id);
    return;
  }
  render();
}

async function showHome() {
  state.error = "";
  try {
    state.library = await getJSON("/api/library");
  } catch (error) {
    state.error = error.message;
  }
  render();
}

async function openDoc(id) {
  state.error = "";
  state.sorts = {};
  state.query = "";
  try {
    state.doc = await getJSON("/api/docs/" + encodeURIComponent(id));
    state.mode = "sheet";
    shellFor = null;
  } catch (error) {
    state.doc = null;
    state.error = error.message;
    shellFor = null;
    state.library = await getJSON("/api/library").catch(() => state.library);
  }
  render();
}

function render() {
  if (!state.doc) {
    app.replaceChildren(homeView());
    return;
  }
  if (shellFor !== state.doc.id) {
    shellFor = state.doc.id;
    app.replaceChildren(shell());
  }
  paint();
}

function homeView() {
  const library = state.library || { documents: [], files: [] };
  const root = h("main", { class: "home" }, [
    h("h1", null, ["Интерактив из PDF"]),
    h("p", { class: "lede" }, [
      "Загрузите PDF. Слева в «Тексте» правятся формулировки и картинки, справа на «Листе» это видно сразу. На листе меняется только размер блоков.",
    ]),
  ]);
  if (state.error) root.append(h("div", { class: "banner" }, [state.error]));

  const input = h("input", { type: "file", accept: "application/pdf" });
  input.addEventListener("change", () => {
    if (input.files[0]) convertFile(input.files[0]);
  });
  const drop = h("div", { class: "drop" }, [
    h("p", null, ["Перетащите PDF сюда или выберите файл с компьютера."]),
    h("button", { class: "btn", type: "button", onclick: () => input.click() }, ["Выбрать PDF"]),
    input,
  ]);
  drop.addEventListener("dragover", (event) => {
    event.preventDefault();
    drop.classList.add("is-over");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("is-over"));
  drop.addEventListener("drop", (event) => {
    event.preventDefault();
    drop.classList.remove("is-over");
    const file = event.dataTransfer.files[0];
    if (file) convertFile(file);
  });
  root.append(drop);

  root.append(filePanel("Файлы в папке", library.files, (file) => {
    const button = h("button", {
      class: "btn",
      type: "button",
      disabled: state.busy ? "true" : null,
      onclick: () => convertLocal(file.name),
    }, [state.busy ? "Собираем…" : "Сделать интерактив"]);
    return h("div", { class: "row" }, [
      h("div", null, [h("b", null, [file.name]), h("span", null, [formatSize(file.size)])]),
      button,
    ]);
  }, "В папке проекта нет PDF."));

  root.append(filePanel("Готовые интерактивы", library.documents, (doc) => {
    return h("div", { class: "row" }, [
      h("div", null, [
        h("b", null, [doc.title || doc.sourceName]),
        h("span", null, [`${doc.sourceName} · ${doc.pageCount} стр.`]),
      ]),
      h("a", { class: "btn ghost", href: "#/doc/" + encodeURIComponent(doc.id) }, ["Открыть"]),
    ]);
  }, "Пока ничего не собрано."));
  return root;
}

function filePanel(title, items, row, empty) {
  const panel = h("section", { class: "panel" }, [h("h2", null, [title])]);
  if (!items.length) panel.append(h("p", { class: "empty" }, [empty]));
  items.forEach((item) => panel.append(row(item)));
  return panel;
}

function shell() {
  const doc = state.doc;
  const back = h("a", { class: "btn ghost", href: "#/" }, ["К файлам"]);
  const search = h("input", {
    type: "search",
    placeholder: "Поиск по тексту",
    value: state.query,
    "aria-label": "Поиск по тексту",
  });
  search.addEventListener("input", () => {
    state.query = search.value.trim();
    paint();
  });
  search.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      search.value = "";
      state.query = "";
      paint();
    }
  });
  const download = h("button", {
    id: "export-pdf",
    class: "btn",
    type: "button",
    onclick: () => exportPdf(),
  }, ["В PDF"]);
  return h("div", { class: "shell" }, [
    h("header", { class: "appbar" }, [
      back,
      h("h1", null, [doc.title || doc.sourceName]),
      h("span", { id: "save-state", class: "save-state" }, ["Сохранено"]),
      h("label", { class: "search" }, [search]),
      download,
    ]),
    h("div", { class: "layout" }, [
      h("nav", { id: "nav", "aria-label": "Содержание" }),
      h("main", { id: "main", class: "main" }),
    ]),
  ]);
}

function appendNavGroup(nav, label, buttons) {
  if (!buttons.length) return;
  if (label) nav.append(h("div", { class: "group" }, [label]));
  const list = h("ul", { class: "nav-list" });
  buttons.forEach((button) => list.append(h("li", null, [button])));
  nav.append(list);
}

function paint() {
  sheetObservers.forEach((item) => item.disconnect());
  sheetObservers = [];
  const doc = state.doc;
  const nav = document.querySelector("#nav");
  const main = document.querySelector("#main");
  if (!nav || !main) return;
  applyDocFonts(doc);
  nav.replaceChildren();
  main.replaceChildren();
  main.classList.toggle("is-split", !!doc.textAvailable);

  if (doc.notice) main.append(h("div", { class: "banner" }, [doc.notice]));

  const sheetPane = doc.textAvailable ? h("div", { id: "pane-sheet", class: "pane pane-sheet" }) : main;
  const textPane = doc.textAvailable ? h("div", { id: "pane-text", class: "pane pane-text" }) : null;
  if (textPane) {
    textPane.append(h("p", { class: "pane-name" }, ["Текст"]));
    sheetPane.append(sheetToolbar(doc));
    main.append(textPane, sheetPane);
  } else {
    sheetPane.append(sheetToolbar(doc));
  }

  const sheetButtons = doc.pages.map((page, index) => h("button", {
    type: "button",
    title: "Лист " + (index + 1),
    onclick: () => document.getElementById("sheet-" + page.number)?.scrollIntoView({ behavior: "smooth", block: "start" }),
  }, ["Лист " + (index + 1)]));
  if (!doc.pages.length) sheetPane.append(h("p", { class: "empty" }, ["Листов нет. Добавьте шаблон листа."]));
  doc.pages.forEach((page) => syncRegions(page));
  doc.pages.forEach((page) => sheetPane.append(sheetPage(doc, page)));
  const jump = state.scrollSheet;
  const sectionJump = state.scrollSection;
  state.scrollSheet = null;
  state.scrollSection = null;
  if (jump) requestAnimationFrame(() => document.getElementById("sheet-" + jump)?.scrollIntoView({ behavior: "smooth", block: "start" }));
  if (sectionJump) requestAnimationFrame(() => document.getElementById(sectionJump)?.scrollIntoView({ behavior: "smooth", block: "start" }));

  if (!textPane) {
    appendNavGroup(nav, "Листы", sheetButtons);
    return;
  }

  let visible = 0;
  doc.pages.forEach((page, index) => {
    const sections = page.sections.filter((section) => sectionMatches(section, state.query));
    if (!sections.length && !leadMatches(page, state.query) && !figureMatches(page)) return;
    visible += 1;
    appendNavGroup(
      nav,
      doc.pages.length > 1 ? "Стр. " + (index + 1) : "Текст",
      sections.map((section) => h("button", {
        type: "button",
        title: section.title || "Новый раздел",
        "data-target": section.id,
        onclick: () => document.getElementById(section.id)?.scrollIntoView({ behavior: "smooth", block: "start" }),
      }, [section.title || "Новый раздел"])),
    );
  });
  appendNavGroup(nav, "Листы", sheetButtons);

  textPane.append(hero(doc));
  doc.pages.forEach((page, index) => {
    if (doc.pages.length > 1) textPane.append(h("h2", { class: "page-label" }, ["Лист " + (index + 1)]));
    if (index > 0 && !state.query) {
      const photos = (page.figures || []).filter((figure) => !isQr(figure));
      photos.forEach((figure) => textPane.append(figureFrame(doc, figure, null, null, page)));
      if (!photos.length) {
        textPane.append(h("button", {
          class: "text-btn",
          type: "button",
          onclick: () => pickImage((src) => {
            page.figures.push({ src, x: 340, y: 66, w: 250, h: 160 });
            paint();
            scheduleSave();
          }),
        }, ["Изображение в шапку"]));
      }
    }
    if (!state.query || leadMatches(page, state.query)) {
      if (index > 0) {
        page.lead.forEach((block, leadIndex) => textPane.append(editableBlock(page.lead, leadIndex, page)));
        textPane.append(addBar(page.lead));
      }
    }
    page.sections.forEach((section) => {
      if (!sectionMatches(section, state.query)) return;
      textPane.append(sectionCard(doc, section, page));
    });
  });
  if (state.query && !visible && !textPane.querySelector(".card")) {
    textPane.append(h("p", { class: "miss" }, ["Ничего не найдено."]));
  }
  textPane.append(footBlock(doc));
  watchSections();
  const focus = document.querySelector("[data-focus='1']");
  if (focus) focus.focus();
}

function sheetToolbar(doc) {
  return h("div", { class: "pane-name pane-tools" }, [
    h("span", null, ["Лист"]),
    h("button", { class: "text-btn", type: "button", onclick: () => addSheet(doc) }, ["Добавить лист"]),
  ]);
}

function addSheet(doc) {
  const page = blankSheet(doc);
  doc.pages.push(page);
  state.scrollSheet = page.number;
  paint();
  scheduleSave();
}

function removeSheet(doc, page) {
  const index = doc.pages.indexOf(page);
  if (index < 0) return;
  doc.pages.splice(index, 1);
  paint();
  scheduleSave();
}

function blankSheet(doc) {
  const sample = doc.pages[0] || { width: 594.96, height: 842.04 };
  const number = doc.pages.reduce((max, page) => Math.max(max, page.number || 0), 0) + 1;
  const qr = templateQr(doc);
  const left = "p" + number + "-s1";
  const right = "p" + number + "-s2";
  return {
    number,
    width: sample.width,
    height: sample.height,
    image: "",
    links: [],
    figures: qr ? [qr] : [],
    lead: [],
    sections: [
      { id: left, title: "", blocks: [], column: "left" },
      { id: right, title: "", blocks: [], column: "right" },
    ],
    layout: [],
    erasers: [],
    regions: [],
    split: 0.42,
  };
}

function templateQr(doc) {
  for (const page of doc.pages || []) {
    const qr = (page.figures || []).find(isQr);
    if (!qr) continue;
    return {
      src: qr.src,
      originalSrc: qr.originalSrc || qr.src,
      x: qr.x,
      y: qr.y,
      w: qr.w,
      h: qr.h,
      role: "qr",
      href: qr.href || "",
    };
  }
  return null;
}

function hero(doc) {
  const node = h("header", { class: "hero" });
  const page = doc.pages[0];
  const rail = navBlock(doc, page);
  if (rail) node.append(rail);
  node.append(headBlock(doc, page));
  return node;
}

function headBlock(doc, page) {
  const block = h("section", { class: "head-block" });
  if (doc.logo) block.append(figureFrame(doc, { src: doc.logo }, "logo", (src) => {
    const previous = doc.logo;
    doc.logo = src;
    doc.pages.forEach((item) => syncSheetImage(item, previous, src));
  }));
  else block.append(h("button", {
    class: "text-btn",
    type: "button",
    onclick: () => pickImage((src) => { doc.logo = src; paint(); scheduleSave(); }),
  }, ["Добавить логотип"]));
  block.append(editable("h2", null, () => doc.title, (value) => {
    doc.title = value;
    const heading = document.querySelector(".appbar h1");
    if (heading) heading.textContent = value || doc.sourceName;
  }, null, null, page, null, null, "title", "head"));
  block.append(editable("p", "subtitle", () => doc.subtitle, (value) => { doc.subtitle = value; }, "Подзаголовок", null, page, null, null, "subtitle", "head"));
  metaOrder(doc).forEach((index) => block.append(editable(
    "span",
    "meta-line",
    () => doc.meta[index],
    (value) => { doc.meta[index] = value; },
    "Поле",
    null,
    page,
    null,
    null,
    "meta-" + index,
    "head",
  )));
  if (page) {
    (page.figures || []).forEach((figure) => {
      if (!isQr(figure)) block.append(figureFrame(doc, figure, null, null, page));
    });
    if (!state.query || leadMatches(page, state.query)) {
      page.lead.forEach((item, index) => block.append(editableBlock(page.lead, index, page)));
      block.append(addBar(page.lead));
    }
  }
  return block;
}

function metaOrder(doc) {
  const items = doc.meta || [];
  const tu = items.findIndex((item) => /^\s*ТУ(?:\s|$)/.test(item || ""));
  const name = items.findIndex((item) => /техническ/i.test(item || ""));
  const order = [];
  if (tu >= 0) order.push(tu);
  if (name >= 0 && name !== tu) order.push(name);
  items.forEach((_, index) => {
    if (!order.includes(index)) order.push(index);
  });
  return order;
}

function navBlock(doc, page) {
  const labels = doc.labels || [];
  const codes = qrEntries(doc);
  if (!labels.length && !codes.length) return null;
  const block = h("section", { class: "nav-block" });
  if (labels.length) block.append(kickerRow(doc, page));
  codes.forEach((entries) => block.append(qrField(doc, entries)));
  return block;
}

function kickerRow(doc, page) {
  const row = h("div", { class: "kicker" });
  doc.labels.forEach((label, index) => {
    const source = labelSource(doc, index);
    const field = editable(
      "span",
      "kicker-field",
      () => doc.labels[index],
      (value) => { doc.labels[index] = value; },
      "Подпись",
      null,
      page,
      labelBindings(doc, index),
      null,
      "label-" + index,
      index < 2 ? "nav" : null,
    );
    const bg = source && source.bg ? source.bg : "#ffffff";
    const fg = source && source.color ? source.color : "#000000";
    field.style.background = bg;
    field.style.color = fg;
    field.style.fontWeight = source && source.bold ? "700" : "400";
    if (lightColor(bg)) field.style.borderColor = "#c5ced4";
    row.append(field);
  });
  return row;
}

function labelSource(doc, index) {
  for (const item of doc.pages || []) {
    const verticals = (item.layout || [])
      .filter((block) => block.type === "text" && block.vertical)
      .sort((a, b) => a.x - b.x || a.y - b.y);
    if (verticals[index]) return verticals[index];
  }
  return null;
}

function lightColor(hex) {
  const value = String(hex || "").replace("#", "");
  if (value.length < 6) return true;
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 210;
}

function isQr(figure) {
  if (!figure) return false;
  if (figure.role === "qr") return true;
  const w = Number(figure.w) || 0;
  const h = Number(figure.h) || 0;
  const side = Math.max(w, h);
  if (side < 36 || side > 96) return false;
  return Math.abs(w - h) / side < 0.18;
}

function qrEntries(doc) {
  const groups = new Map();
  (doc.pages || []).forEach((page) => {
    (page.figures || []).forEach((figure) => {
      if (!isQr(figure)) return;
      const key = figure.href || "";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ page, figure });
    });
  });
  return [...groups.values()];
}

function qrField(doc, entries) {
  const figure = entries[0] && entries[0].figure;
  const input = h("input", {
    type: "url",
    placeholder: "https://",
    value: figure ? figure.href || "" : "",
    spellcheck: "false",
  });
  const commit = () => {
    const value = input.value.trim();
    input.value = value;
    applyQr(doc, entries, value).catch((error) => setStatus(error.message));
  };
  input.addEventListener("focus", () => highlightSheet("nav"));
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    commit();
  });
  input.addEventListener("blur", commit);
  const field = h("label", { class: "qr-field" + (figure && figure.src ? " has-preview" : "") }, [
    figure && figure.src ? h("img", { class: "qr-preview", src: media(doc, figure.src), alt: "QR" }) : null,
    h("span", null, ["Ссылка для QR"]),
    input,
  ]);
  return field;
}

async function applyQr(doc, entries, href) {
  const current = entries[0].figure.href || "";
  if (href === current) return;
  if (!href) {
    entries.forEach(({ page, figure }) => {
      const previous = figure.src;
      const original = figure.originalSrc || previous;
      figure.href = "";
      figure.src = original;
      syncSheetImage(page, previous, original);
    });
    scheduleSave();
    return;
  }
  setStatus("Собираем QR…");
  const result = await getJSON("/api/docs/" + encodeURIComponent(doc.id) + "/qr", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ href }),
  });
  entries.forEach(({ page, figure }) => {
    if (!figure.originalSrc) figure.originalSrc = figure.src;
    const previous = figure.src;
    figure.href = href;
    figure.src = result.src;
    syncSheetImage(page, previous, result.src);
    replaceSheetImage(page, previous, result.src);
  });
  scheduleSave();
}

function figureFrame(doc, figure, className, onReplace, page) {
  const fig = h("figure", { class: className === "logo" ? "logo-frame" : "figure" }, [
    h("img", { class: className || "", src: media(doc, figure.src), alt: "" }),
  ]);
  fig.append(h("button", {
    class: "text-btn",
    type: "button",
    onclick: () => pickImage((src) => {
      const previous = figure.src;
      if (onReplace) onReplace(src);
      else {
        figure.src = src;
        if (page) syncSheetImage(page, previous, src);
      }
      paint();
      scheduleSave();
    }),
  }, ["Заменить"]));
  return fig;
}

function sectionCard(doc, section, page) {
  const card = h("section", { class: "card", id: section.id });
  const scope = sectionMembers(page, section);
  const title = editable("h3", null, () => section.title, (value) => { section.title = value; }, "Название раздела", null, page, null, scope, "sec-" + section.id, section.id);
  title.addEventListener("blur", () => {
    const button = document.querySelector(`#nav button[data-target="${section.id}"]`);
    if (button) {
      button.textContent = section.title || "Без названия";
      button.title = button.textContent;
    }
  });
  const head = h("div", { class: "card-head" });
  head.append(iconField(doc, section));
  head.append(title);
  const move = sectionMoveControl(page, section);
  if (move) head.append(move);
  card.append(head);
  section.blocks.forEach((block, index) => {
    if (block.type === "table") card.append(tableBlock(section.id + "-" + index, block, page, scope, section.blocks, index, section));
    else card.append(editableBlock(section.blocks, index, page, scope, section));
  });
  card.append(addBar(section.blocks));
  return card;
}

function editableBlock(list, index, page, scope, section) {
  const block = list[index];
  const wrap = h("div", { class: "block" });
  wrap.append(blockBody(block, page, scope, sheetIds(section, page, index)));
  wrap.append(h("button", {
    class: "text-btn",
    type: "button",
    onclick: () => {
      list.splice(index, 1);
      paint();
      scheduleSave();
    },
  }, ["Удалить"]));
  return wrap;
}

function sectionIconOn(section) {
  return section.iconOn !== false;
}

function iconField(doc, section) {
  const on = sectionIconOn(section);
  const field = h("div", { class: "icon-field" + (on ? "" : " is-off") });
  if (section.icon) field.append(h("img", { class: "card-icon", src: media(doc, section.icon), alt: "" }));
  else field.append(h("span", { class: "card-icon " + (on ? "card-icon-mark" : "card-icon-empty") }));
  field.append(h("div", { class: "icon-actions" }, [
    h("button", {
      class: "text-btn",
      type: "button",
      onclick: () => pickImage((src) => {
        section.icon = src;
        section.iconOn = true;
        paint();
        scheduleSave();
      }),
    }, [section.icon ? "Заменить" : "Добавить"]),
    h("button", {
      class: "text-btn",
      type: "button",
      onclick: () => {
        section.iconOn = !on;
        paint();
        scheduleSave();
      },
    }, [on ? "Выключить" : "Включить"]),
  ]));
  return field;
}

function sectionMoveControl(page, section) {
  const doc = state.doc;
  const targets = (doc.pages || []).filter((item) => item !== page);
  if (!targets.length) return null;
  const select = h("select", { class: "move-block", title: "Перенести блок на другой лист" });
  select.append(h("option", { value: "" }, ["На лист…"]));
  targets.forEach((target) => {
    const index = doc.pages.indexOf(target);
    select.append(h("option", { value: String(target.number) }, ["Лист " + (index + 1)]));
  });
  select.addEventListener("change", () => {
    const target = doc.pages.find((item) => String(item.number) === select.value);
    if (!target) return;
    moveSection(page, section, target);
  });
  return select;
}

function moveSection(page, section, target) {
  const index = page.sections.indexOf(section);
  if (index < 0) return;
  section.column = sectionSide(page, section);
  page.sections.splice(index, 1);
  if (!target.sections) target.sections = [];
  target.sections.push(section);
  state.scrollSheet = target.number;
  state.scrollSection = section.id;
  paint();
  scheduleSave();
}

function sectionSide(page, section) {
  if (section.column === "left" || section.column === "right") return section.column;
  return sheetColumns(page).right.includes(section) ? "right" : "left";
}

function sheetIds(section, page, index) {
  if (!section) {
    return {
      mark: "head",
      text: `p${page.number}-lead-${index}`,
      item: (item) => `p${page.number}-lead-${index}-${item}`,
    };
  }
  return {
    mark: section.id,
    text: `blk-${section.id}-${index}`,
    item: (item) => `item-${section.id}-${index}-${item}`,
  };
}

function blockBody(block, page, scope, ids) {
  const mark = ids ? ids.mark : null;
  if (block.type === "list") return listEditor(block, page, scope, ids);
  if (block.type === "image") {
    return figureFrame(state.doc, block, null, null, page);
  }
  const className = block.type === "warning" ? "warning" : block.type === "note" ? "note" : null;
  const placeholder = block.type === "warning" ? "Важное замечание" : block.type === "note" ? "Примечание" : "Текст абзаца";
  return editable("p", className, () => block.text, (value) => { block.text = value; }, placeholder, block, page, null, scope, ids && ids.text, mark);
}

function listEditor(block, page, scope, ids) {
  const wrap = h("div", { class: "list-editor" });
  const ul = h("ul");
  (block.items || []).forEach((item, index) => {
    const text = editable("span", null, () => block.items[index], (value) => { block.items[index] = value; }, "Пункт списка", index === block.items.length - 1 ? block : null, page, null, scope, ids && ids.item(index), ids && ids.mark);
    ul.append(h("li", null, [
      text,
      h("button", {
        class: "text-btn",
        type: "button",
        onclick: () => {
          block.items.splice(index, 1);
          if (!block.items.length) block.items.push("");
          paint();
          scheduleSave();
        },
      }, ["×"]),
    ]));
  });
  wrap.append(ul);
  wrap.append(h("button", {
    class: "text-btn",
    type: "button",
    onclick: () => {
      block.items.push("");
      block._focus = true;
      paint();
      scheduleSave();
    },
  }, ["Пункт"]));
  return wrap;
}

function addBar(list) {
  const add = (type) => {
    if (type === "image") {
      pickImage((src) => {
        list.push({ type: "image", src });
        paint();
        scheduleSave();
      });
      return;
    }
    if (type === "table") {
      list.push({
        type: "table",
        headers: ["Столбец 1", "Столбец 2"],
        rows: [["", ""], ["", ""]],
        _focus: true,
      });
      paint();
      scheduleSave();
      return;
    }
    const block = type === "list" ? { type, items: [""], _focus: true } : { type, text: "", _focus: true };
    list.push(block);
    paint();
    scheduleSave();
  };
  return h("div", { class: "edit-bar" }, [
    h("button", { class: "text-btn", type: "button", onclick: () => add("paragraph") }, ["Абзац"]),
    h("button", { class: "text-btn", type: "button", onclick: () => add("list") }, ["Список"]),
    h("button", { class: "text-btn", type: "button", onclick: () => add("note") }, ["Примечание"]),
    h("button", { class: "text-btn", type: "button", onclick: () => add("warning") }, ["Важно"]),
    h("button", { class: "text-btn", type: "button", onclick: () => add("image") }, ["Картинка"]),
    h("button", { class: "text-btn", type: "button", onclick: () => add("table") }, ["Таблица"]),
  ]);
}

function editable(tag, className, get, set, placeholder, block, page, targets, scope, bind, mark) {
  const props = { class: className, contenteditable: "true", spellcheck: "true" };
  if (placeholder) props["data-placeholder"] = placeholder;
  if (block && block._focus) {
    props["data-focus"] = "1";
    delete block._focus;
  }
  const bindings = targets || bindSheet(page, get(), null, scope);
  const node = h(tag, props);
  node.textContent = get() || "";
  node.addEventListener("focus", () => {
    showBindings(bindings);
    highlightSheet(mark);
  });
  node.addEventListener("input", () => {
    const previous = get();
    set(node.textContent);
    writeSheet(bindings, previous, node.textContent);
    reflectSheet(bind, node.textContent);
    scheduleSave();
  });
  node.addEventListener("blur", () => {
    const previous = get();
    const value = node.textContent.replace(/\s+/g, " ").trim();
    node.textContent = value;
    set(value);
    writeSheet(bindings, previous, value);
    reflectSheet(bind, value);
    scheduleSave();
  });
  return node;
}

function tableBlock(key, table, page, scope, list, index, section) {
  const mark = section ? section.id : null;
  const sort = state.sorts[key];
  let rows = table.rows.map((row, index) => ({ row, index }));
  if (state.query) {
    rows = rows.filter((item) => item.row.join(" ").toLowerCase().includes(state.query.toLowerCase())
      || table.headers.join(" ").toLowerCase().includes(state.query.toLowerCase()));
  }
  if (sort) {
    const direction = sort.dir === "desc" ? -1 : 1;
    rows.sort((a, b) => compareCell(a.row[sort.index], b.row[sort.index]) * direction);
  }

  const wrap = h("div", { class: "table-block" });

  const head = h("tr", null, table.headers.map((header, column) => {
    const arrow = sort && sort.index === column ? (sort.dir === "asc" ? " ↑" : " ↓") : "";
    const label = h("span", { contenteditable: "true", spellcheck: "true" }, [header]);
    if (table._focus && column === 0) {
      label.dataset.focus = "1";
      delete table._focus;
    }
    label.addEventListener("click", (event) => event.stopPropagation());
    label.addEventListener("focus", () => highlightSheet(mark));
    label.addEventListener("input", () => {
      table.headers[column] = label.textContent;
      reflectSheet(`th-${key}-${column}`, label.textContent);
      scheduleSave();
    });
    label.addEventListener("blur", () => {
      const value = label.textContent.replace(/\s+/g, " ").trim();
      label.textContent = value;
      table.headers[column] = value;
      reflectSheet(`th-${key}-${column}`, value);
      scheduleSave();
    });
    return h("th", {
      scope: "col",
      onclick: () => {
        const current = state.sorts[key];
        const dir = current && current.index === column && current.dir === "asc" ? "desc" : "asc";
        state.sorts[key] = { index: column, dir };
        paint();
      },
    }, [label, arrow]);
  }));
  const body = h("tbody");
  rows.forEach((item) => {
    const tr = h("tr");
    item.row.forEach((cell, column) => tr.append(h("td", null, [
      cellEditor(item.row, column, page, scope, `td-${key}-${item.index}-${column}`, mark),
    ])));
    if (list) {
      tr.append(h("td", { class: "row-x" }, [h("button", {
        class: "text-btn",
        type: "button",
        onclick: () => {
          if (table.rows.length < 2) return;
          table.rows.splice(item.index, 1);
          paint();
          scheduleSave();
        },
      }, ["×"])]));
    }
    body.append(tr);
  });
  if (!rows.length) body.append(h("tr", null, [h("td", { colspan: String(table.headers.length) }, ["Нет строк по этому отбору."])]));
  wrap.append(h("div", { class: "table-wrap" }, [h("table", null, [h("thead", null, [head]), body])]));
  if (list) {
    const grow = (kind) => {
      if (kind === "row") table.rows.push(table.headers.map(() => ""));
      if (kind === "column") {
        table.headers.push("Столбец " + (table.headers.length + 1));
        table.rows.forEach((row) => row.push(""));
      }
      paint();
      scheduleSave();
    };
    wrap.append(h("div", { class: "edit-bar" }, [
      h("button", { class: "text-btn", type: "button", onclick: () => grow("row") }, ["Строка"]),
      h("button", { class: "text-btn", type: "button", onclick: () => grow("column") }, ["Столбец"]),
      h("button", { class: "text-btn", type: "button", onclick: () => {
        list.splice(index, 1);
        paint();
        scheduleSave();
      } }, ["Удалить"]),
    ]));
  }
  return wrap;
}

function cellEditor(row, index, page, scope, bind, mark) {
  const bindings = bindSheet(page, row[index], row, scope);
  const node = h("div", { contenteditable: "true", spellcheck: "true" });
  node.textContent = row[index] || "";
  node.addEventListener("focus", () => {
    showBindings(bindings);
    highlightSheet(mark);
  });
  node.addEventListener("input", () => {
    const previous = row[index];
    row[index] = node.textContent;
    writeSheet(bindings, previous, node.textContent);
    reflectSheet(bind, node.textContent);
    scheduleSave();
  });
  node.addEventListener("blur", () => {
    const previous = row[index];
    const value = node.textContent.replace(/\s+/g, " ").trim();
    node.textContent = value;
    row[index] = value;
    writeSheet(bindings, previous, value);
    reflectSheet(bind, value);
    scheduleSave();
  });
  return node;
}

function labelBindings(doc, index) {
  const bindings = [];
  (doc.pages || []).forEach((page) => {
    const verticals = (page.layout || [])
      .filter((block) => block.type === "text" && block.vertical)
      .sort((a, b) => a.x - b.x || a.y - b.y);
    const target = verticals[index];
    if (!target) return;
    bindings.push({ page, id: target.id, mode: "whole", anchor: doc.labels[index] });
  });
  return bindings;
}

function bindSheet(page, value, hint, scope) {
  const block = locateSheetBlock(page, value, hint, scope);
  if (!block) return [];
  if (hint) return [{ page, id: block.id, mode: "row", row: hint, originals: hint.slice() }];
  const mode = normText(block.text) === normText(value) ? "whole" : "span";
  return [{ page, id: block.id, mode, anchor: value }];
}

function locateSheetBlock(page, value, hint, scope) {
  const found = findSheetBlock(page, value, hint, scope);
  if (found || !scope || !scope.length) return found;
  return findSheetBlock(page, value, hint, null);
}

function findSheetBlock(page, value, hint, scope) {
  const from = normText(value);
  if (!page || !from) return null;
  const texts = ((scope && scope.length ? scope : page.layout) || []).filter((block) => block && block.type === "text");
  const exact = texts.filter((block) => normText(block.text) === from);
  if (exact.length === 1) return exact[0];
  if (hint) {
    const ranked = texts
      .map((block) => ({ block, score: rowFit(block.text, hint) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);
    if (ranked.length && (!ranked[1] || ranked[0].score > ranked[1].score)) return ranked[0].block;
  }
  const spanned = texts.filter((block) => hasSheetSpan(block.text, value));
  if (spanned.length === 1) return spanned[0];
  if (!hint && spanned.length > 1) {
    spanned.sort((a, b) => normText(a.text).length - normText(b.text).length);
    if (normText(spanned[0].text).length < normText(spanned[1].text).length) return spanned[0];
  }
  return null;
}

function rowFit(text, row) {
  const cells = row.map((cell) => normText(cell)).filter(Boolean).sort((a, b) => b.length - a.length);
  const rest = normText(text);
  let score = 0;
  cells.forEach((cell) => {
    if (rest.includes(cell)) {
      score += cell.length;
      return;
    }
    if (cell.length < 24) return;
    let length = Math.min(cell.length, 80);
    while (length >= 24 && !rest.includes(cell.slice(0, length))) length -= 1;
    if (length >= 24) score += 500 + length;
  });
  return score;
}

function writeSheet(bindings, previous, next) {
  (bindings || []).forEach((binding) => {
    const page = binding.page;
    const block = (page.layout || []).find((item) => item.id === binding.id);
    if (!block) return;
    let updated = binding.mode === "whole"
      ? next
      : binding.mode === "row"
        ? renderRowBlock(block, binding.row, binding.originals)
        : replaceLoose(block.text, binding.anchor || previous, next);
    if (binding.mode === "span" && updated === block.text) updated = replaceLoose(block.text, previous, next);
    if (updated === block.text && binding.mode === "span") return;
    if (binding.mode === "whole") updated = keepMarker(block.original, updated);
    if (block.original && normText(updated) === normText(block.original)) updated = block.original;
    block.text = updated;
    if (binding.mode === "span" || binding.mode === "whole") binding.anchor = next;
    const region = regionOf(page, block);
    if ((!region || !regionMoved(region)) && block.origin && block.text === (block.original || "")) {
      block.x = block.origin.x;
      block.y = block.origin.y;
      block.w = block.origin.w;
      block.h = block.origin.h;
    }
    const node = document.querySelector(`#pane-sheet [data-block="${CSS.escape(block.id)}"]`);
    if (!node) return;
    const text = node.querySelector(".text");
    if (text) text.innerText = block.text;
    placeBlock(node, page, block);
    const rewritten = block.type === "text" && (block.text || "") !== (block.original || "");
    node.classList.toggle("is-rewritten", rewritten);
    node.classList.toggle("is-live", rewritten || (!node.classList.contains("is-member") && blockDirty(block)));
    node.style.setProperty("--size", block.size || 11);
    node.style.setProperty("--lh", String(textLeading(block)));
    node.style.setProperty("--fit", "1");
    const frame = node.closest(".page");
    if (frame) renderMasks(frame, page);
  });
}

function renderRowBlock(block, row, originals) {
  const source = block.original || block.text;
  if (!originals || originals.every((value, index) => normText(row[index]) === normText(value))) return source;
  const order = originals
    .map((value, index) => ({ index, value }))
    .sort((a, b) => normText(b.value).length - normText(a.value).length);
  return order.reduce((text, item) => {
    if (normText(row[item.index]) === normText(item.value)) return text;
    const others = originals.filter((_, index) => index !== item.index);
    return replaceSplit(text, item.value, row[item.index], others);
  }, source);
}

function replaceSplit(text, previous, next, others) {
  const exact = replaceSheetText(text, previous, next);
  if (exact !== text) return exact;
  const from = normText(previous);
  if (!from) return text;
  const lines = String(text || "").split("\n");
  const index = lines.findIndex((line) => {
    const piece = normText(line);
    return piece.length > 12 && from.startsWith(piece);
  });
  if (index < 0) return text;
  const foreign = (others || []).map((item) => normText(item)).filter((item) => item && item !== from);
  const kept = [];
  let placed = false;
  lines.forEach((line, lineIndex) => {
    const piece = normText(line);
    const foreignLine = foreign.some((item) => item === piece || (piece && item.includes(piece) && piece.length <= item.length));
    const belongs = !foreignLine && (lineIndex === index || (piece && from.includes(piece)));
    if (!belongs) {
      kept.push(line);
      return;
    }
    if (!placed) {
      kept.push(next);
      placed = true;
    }
  });
  return kept.join("\n");
}

function replaceLoose(text, previous, next) {
  const exact = replaceSheetText(text, previous, next);
  if (exact !== text) return exact;
  const from = normText(previous);
  if (!from) return text;
  const lines = String(text || "").split("\n");
  const index = lines.findIndex((line) => {
    const piece = normText(line);
    return piece.length > 12 && from.startsWith(piece);
  });
  if (index < 0) return text;
  let end = index;
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const piece = normText(lines[cursor]);
    if (!piece) continue;
    if (from.includes(piece)) {
      end = cursor;
      continue;
    }
    break;
  }
  const copy = lines.slice();
  copy.splice(index, end - index + 1, next);
  return copy.join("\n");
}

function replaceSheetImage(page, previous, next) {
  const sheet = document.getElementById("sheet-" + page.number);
  if (!sheet || !previous || previous === next) return;
  const needle = previous.split("/").pop();
  sheet.querySelectorAll("img").forEach((img) => {
    const src = img.getAttribute("src") || "";
    if (src.includes(needle)) img.src = media(state.doc, next);
  });
}

function syncSheetImage(page, previous, next) {
  if (!page || !previous || previous === next) return;
  (page.layout || []).forEach((block) => {
    if (block.type !== "image") return;
    if (block.src !== previous && block.originalSrc !== previous) return;
    block.src = next;
    const node = document.querySelector(`#pane-sheet [data-block="${CSS.escape(block.id)}"] img`);
    if (!node) return;
    node.src = media(state.doc, next);
    const frame = node.closest(".page");
    const blockNode = node.closest(".layout-block");
    if (blockNode) blockNode.classList.toggle("is-live", blockDirty(block));
    if (frame) renderMasks(frame, page);
  });
}

function textMatches(text, token) {
  const from = normText(token);
  if (!from) return false;
  const whole = normText(text);
  if (whole === from || whole.includes(from)) return true;
  return String(text || "").split("\n").some((line) => normText(line) === from)
    || whole.split(" ").includes(from);
}

function hasSheetSpan(text, previous) {
  return replaceSheetText(text, previous, "\u0000") !== text;
}

function replaceSheetText(text, previous, next) {
  const from = normText(previous);
  if (!from) return text;
  if (normText(text) === from) return next;
  const lines = String(text || "").split("\n");
  for (let start = 0; start < lines.length; start += 1) {
    let acc = "";
    for (let end = start; end < lines.length; end += 1) {
      acc = acc ? acc + " " + lines[end].trim() : lines[end].trim();
      if (normText(acc) === from) {
        const copy = lines.slice();
        copy.splice(start, end - start + 1, next);
        return copy.join("\n");
      }
      if (normText(acc).length > from.length) break;
    }
  }
  const parts = String(text || "").split(/(\s+)/);
  let done = false;
  const replaced = parts.map((part) => {
    if (!done && normText(part) === from) {
      done = true;
      return next;
    }
    return part;
  }).join("");
  return done ? replaced : text;
}

function normText(value) {
  return String(value || "")
    .replace(/\u00ad/g, "")
    .replace(/-\s+/g, "")
    .replace(/[•·●]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function syncRegions(page) {
  if (!page.layout) page.layout = [];
  const ids = new Set(page.layout.map((block) => block.id));
  const valid = page.regions
    && page.regions.length
    && page.regions.every((region) => (region.blockIds || []).every((id) => ids.has(id)));
  if (!valid) page.regions = buildRegions(page);
  return page.regions;
}

function sectionMembers(page, section) {
  syncRegions(page);
  const region = (page.regions || []).find((item) => item.id === section.id);
  if (!region) return null;
  const byId = new Map((page.layout || []).map((block) => [block.id, block]));
  const members = region.blockIds.map((id) => byId.get(id)).filter(Boolean);
  return members.length ? members : null;
}

function buildRegions(page) {
  const layout = page.layout || [];
  const sections = page.sections || [];
  const partLists = sections.map(sectionParts);
  const assigned = new Map();
  layout.forEach((block) => {
    if (block.type !== "text" || block.vertical) return;
    const text = normText(block.text);
    let best = -1;
    let bestScore = 0;
    let second = 0;
    partLists.forEach((list, index) => {
      const score = textScore(text, list);
      if (score > bestScore) {
        second = bestScore;
        bestScore = score;
        best = index;
      } else if (score > second) second = score;
    });
    if (best >= 0 && bestScore >= 500 && bestScore > second) assigned.set(block.id, best);
  });
  const boxes = () => sections.map((_, index) => {
    const members = layout.filter((block) => assigned.get(block.id) === index);
    return members.length ? unionBox(members) : null;
  });
  let changed = true;
  while (changed) {
    changed = false;
    const current = boxes();
    layout.forEach((block) => {
      if (block.type !== "text" || block.vertical || assigned.has(block.id)) return;
      const hits = [];
      current.forEach((box, index) => {
        if (box && centerInside(block, box, 14)) hits.push(index);
      });
      if (hits.length === 1) {
        assigned.set(block.id, hits[0]);
        changed = true;
      }
    });
  }
  const used = new Set();
  const regions = [];
  sections.forEach((section, index) => {
    const members = layout.filter((block) => assigned.get(block.id) === index);
    if (!members.length) return;
    members.forEach((block) => used.add(block.id));
    const box = padBox(unionBox(members));
    regions.push({
      id: section.id,
      kind: "section",
      title: section.title || "",
      blockIds: members.map((block) => block.id),
      x: box.x,
      y: box.y,
      w: box.w,
      h: box.h,
      origin: { x: box.x, y: box.y, w: box.w, h: box.h },
    });
  });
  return regions;
}

function sectionParts(section) {
  const parts = [section.title];
  (section.blocks || []).forEach((block) => {
    if (block.text) parts.push(block.text);
    (block.items || []).forEach((item) => parts.push(item));
    (block.headers || []).forEach((item) => parts.push(item));
    (block.rows || []).forEach((row) => row.forEach((cell) => parts.push(cell)));
  });
  return parts.map(normText).filter(Boolean);
}

function textScore(text, parts) {
  if (!text) return 0;
  let best = 0;
  parts.forEach((part) => {
    if (!part) return;
    if (text === part) best = Math.max(best, 2000 + part.length);
    else if (part.includes(text) && text.length >= 10) best = Math.max(best, 500 + text.length);
    else if (text.includes(part) && part.length >= 10) best = Math.max(best, 500 + part.length);
  });
  return best;
}

function unionBox(blocks) {
  const x0 = Math.min(...blocks.map((box) => box.x));
  const y0 = Math.min(...blocks.map((box) => box.y));
  const x1 = Math.max(...blocks.map((box) => box.x + box.w));
  const y1 = Math.max(...blocks.map((box) => box.y + box.h));
  return { x: round1(x0), y: round1(y0), w: round1(x1 - x0), h: round1(y1 - y0) };
}

function padBox(box) {
  return {
    x: round1(box.x - 8),
    y: round1(box.y - 14),
    w: round1(box.w + 11),
    h: round1(box.h + 18),
  };
}

function centerInside(block, box, margin) {
  const cx = block.x + block.w / 2;
  const cy = block.y + block.h / 2;
  return cx >= box.x - margin && cx <= box.x + box.w + margin && cy >= box.y - margin && cy <= box.y + box.h + margin;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function regionOf(page, block) {
  return (page.regions || []).find((region) => region.kind === "section" && region.blockIds.includes(block.id)) || null;
}

function regionMoved(region) {
  const origin = region && region.origin;
  if (!origin) return false;
  return ["x", "y", "w", "h"].some((key) => Math.abs(Number(region[key]) - Number(origin[key])) > 0.6);
}

function reflectSheet(bind, value) {
  if (!bind) return;
  const text = value == null ? "" : String(value);
  document.querySelectorAll(`#pane-sheet [data-bind="${CSS.escape(bind)}"]`).forEach((node) => {
    if (node.textContent !== text) node.textContent = text;
    if (!bind.startsWith("sec-")) return;
    const section = node.closest(".sheet-sec");
    if (!section) return;
    const hasBlocks = section.querySelector("p, ul, table, .sheet-inline");
    section.classList.toggle("is-empty", !text.trim() && !hasBlocks);
  });
}

function highlightSheet(mark) {
  document.querySelectorAll("#pane-sheet .is-on").forEach((node) => node.classList.remove("is-on"));
  if (!mark) return;
  const selector = mark === "head"
    ? "#pane-sheet .sheet-head"
    : mark === "nav"
      ? "#pane-sheet .sheet-nav"
      : mark === "foot"
        ? "#pane-sheet .sheet-foot"
        : `#pane-sheet [data-section="${CSS.escape(mark)}"]`;
  document.querySelectorAll(selector).forEach((node) => node.classList.add("is-on"));
}

function sheetPage(doc, page) {
  const index = Math.max(0, doc.pages.indexOf(page));
  const article = h("article", { class: "sheet", id: "sheet-" + page.number });
  article.append(h("div", { class: "sheet-tools" }, [
    h("span", null, ["Лист " + (index + 1)]),
    h("button", { class: "text-btn", type: "button", onclick: () => removeSheet(doc, page) }, ["Удалить"]),
  ]));
  const scaler = h("div", { class: "sheet-scale" });
  const box = sheetBox(doc, page);
  scaler.append(box);
  article.append(scaler);
  const fit = () => {
    const width = article.clientWidth;
    if (!width) return;
    const scale = Math.min(width / page.width, 1.2);
    box.style.transform = `scale(${scale})`;
    scaler.style.width = (page.width * scale) + "px";
    scaler.style.height = (page.height * scale) + "px";
  };
  const observer = new ResizeObserver(fit);
  observer.observe(article);
  sheetObservers.push(observer);
  requestAnimationFrame(fit);
  return article;
}

function sheetBox(doc, page) {
  const navW = doc.navWidth || 64.8;
  const navBar = doc.navBar || 317.8;
  const navQr = doc.navQr || 61.2;
  const box = h("div", { class: "sheet-page" });
  box.style.width = page.width + "px";
  box.style.height = page.height + "px";
  box.append(sheetNav(doc, page, navW, navBar, navQr), sheetBody(doc, page, navW));
  return box;
}

function sheetNav(doc, page, navW, navBar, navQr) {
  const nav = h("aside", { class: "sheet-nav" });
  nav.style.width = navW + "px";
  nav.style.flexBasis = navW + "px";
  const brand = h("div", { class: "nav-brand" });
  brand.style.height = navBar + "px";
  brand.style.flexBasis = navBar + "px";
  if (doc.navBrand) {
    brand.style.backgroundImage = `url("${media(doc, doc.navBrand)}")`;
  }
  brand.append(h("div", { class: "nav-v" }, [
    h("span", { "data-bind": "label-0" }, [doc.labels[0] || ""]),
  ]));
  const topic = h("div", { class: "nav-topic" }, [
    h("div", { class: "nav-v" }, [
      h("span", { "data-bind": "label-1" }, [doc.labels[1] || ""]),
    ]),
  ]);
  const qr = (page.figures || []).find(isQr);
  const qrBox = h("div", { class: "nav-qr" });
  qrBox.style.height = navQr + "px";
  qrBox.style.flexBasis = navQr + "px";
  if (qr) {
    const image = h("img", { src: media(doc, qr.src), alt: "QR" });
    if (qr.href) {
      const link = h("a", { href: qr.href, target: "_blank", rel: "noopener" });
      link.append(image);
      qrBox.append(link);
    } else qrBox.append(image);
  }
  nav.append(brand, topic, qrBox);
  return nav;
}

function sheetBody(doc, page, navW) {
  const body = h("div", { class: "sheet-body" });
  const family = docFontFamily(doc);
  if (family) body.style.fontFamily = `"${family}", Arial, "Helvetica Neue", sans-serif`;
  body.append(sheetHead(doc, page), sheetMain(doc, page, navW), sheetFoot(doc));
  return body;
}

function sheetHead(doc, page) {
  const head = h("header", { class: "sheet-head" });
  const left = h("div", { class: "head-left" });
  if (doc.logo) left.append(logoFrame(doc, page));
  left.append(h("h2", { class: "sheet-title", "data-bind": "title" }, [doc.title || ""]));
  left.append(h("p", { class: "sheet-sub", "data-bind": "subtitle" }, [page.subtitle || doc.subtitle || ""]));
  const slots = metaSlots(doc);
  if (slots.tu >= 0) left.append(h("p", { class: "sheet-tu", "data-bind": "meta-" + slots.tu }, [doc.meta[slots.tu]]));
  page.lead.forEach((block, index) => left.append(renderLead(page, block, index)));
  const right = h("div", { class: "head-right" });
  if (slots.name >= 0) right.append(h("p", { class: "sheet-docname", "data-bind": "meta-" + slots.name }, [doc.meta[slots.name]]));
  const figure = heroFigure(page);
  const wide = figure && figure.w > page.width * 0.62;
  if (!wide) right.append(h("i", { class: "sheet-rule" }));
  if (figure && !wide) right.append(heroFrame(doc, page, figure, false));
  head.append(left, right);
  if (figure && wide) {
    head.classList.add("is-banner");
    head.append(heroFrame(doc, page, figure, true));
  }
  return head;
}

function heroFrame(doc, page, figure, wide) {
  const frame = h("div", { class: "hero-frame " + (wide ? "sheet-banner" : "sheet-hero") });
  if (figure.displayW) {
    frame.style.width = figure.displayW + "px";
    frame.classList.add("is-sized");
  }
  frame.append(h("img", { src: media(doc, figure.src), alt: "" }));
  addResizeHandles(frame, (event, corner) => resizeHero(event, page, figure, frame, corner));
  return frame;
}

function logoFrame(doc, page) {
  const frame = h("div", { class: "logo-resize" });
  if (doc.logoH) frame.style.height = doc.logoH + "px";
  frame.append(h("img", { class: "sheet-logo", src: media(doc, doc.logo), alt: "" }));
  addResizeHandles(frame, (event, corner) => resizeLogo(event, page, frame, corner));
  return frame;
}

function addResizeHandles(frame, onResize) {
  ["nw", "ne", "sw", "se"].forEach((corner) => {
    const handle = h("i", { class: "handle handle-" + corner, title: "Изменить размер" });
    handle.addEventListener("pointerdown", (event) => onResize(event, corner));
    frame.append(handle);
  });
}

function resizeHero(event, page, figure, frame, corner) {
  const body = frame.closest(".sheet-body");
  frame.style.height = "";
  frame.classList.add("is-sized");
  resizeRatio(event, page, frame, corner, {
    minW: 64,
    minH: 36,
    maxW: Math.max(80, body.clientWidth),
    maxH: Math.round(page.height * 0.48),
  }, (width) => {
    figure.displayW = width;
    delete figure.displayH;
    frame.style.width = width + "px";
    frame.style.height = "";
  });
}

function resizeLogo(event, page, frame, corner) {
  const doc = state.doc;
  const host = frame.closest(".head-left");
  resizeRatio(event, page, frame, corner, {
    minW: 28,
    minH: 16,
    maxW: Math.max(48, host.clientWidth),
    maxH: Math.round(page.height * 0.22),
  }, (_width, height) => {
    doc.logoH = height;
    frame.style.height = height + "px";
  });
}

function resizeRatio(event, page, frame, corner, limits, apply) {
  const sheet = frame.closest(".sheet-page");
  const scale = pageScale(sheet, page);
  const img = frame.querySelector("img");
  const ratio = img && img.naturalWidth && img.naturalHeight
    ? img.naturalWidth / img.naturalHeight
    : frame.offsetWidth / Math.max(frame.offsetHeight, 1);
  const start = { x: event.clientX, y: event.clientY, w: frame.offsetWidth, h: frame.offsetHeight };
  frame.classList.add("is-on");
  trackPointer(event, (ev) => {
    let dw = (ev.clientX - start.x) * scale.x;
    let dh = (ev.clientY - start.y) * scale.y;
    if (corner.includes("w")) dw = -dw;
    if (corner.includes("n")) dh = -dh;
    const byWidth = start.w + dw;
    const byHeight = (start.h + dh) * ratio;
    const width = Math.abs(dw) >= Math.abs(dh) ? byWidth : byHeight;
    const minW = Math.max(limits.minW, limits.minH * ratio);
    const maxW = Math.max(minW, Math.min(limits.maxW, limits.maxH * ratio));
    const next = clamp(Math.round(width), Math.round(minW), Math.round(maxW));
    apply(next, Math.max(1, Math.round(next / ratio)));
  }, () => {
    frame.classList.remove("is-on");
    scheduleSave();
  });
}

function metaSlots(doc) {
  const items = doc.meta || [];
  const tu = items.findIndex((item) => /^\s*ТУ(?:\s|$)/.test(item || ""));
  let name = items.findIndex((item) => /техническ/i.test(item || ""));
  if (name < 0) name = items.findIndex((_, index) => index !== tu);
  return { tu, name };
}

function heroFigure(page) {
  return (page.figures || []).filter((figure) => !isQr(figure)).sort((a, b) => b.w * b.h - a.w * a.h)[0] || null;
}

function renderLead(page, block, index) {
  if (block.type === "list") {
    return h("ul", { class: "sheet-lead" }, (block.items || []).map((item, itemIndex) => h("li", {
      "data-bind": `p${page.number}-lead-${index}-${itemIndex}`,
    }, [item])));
  }
  return h("p", { class: "sheet-lead", "data-bind": `p${page.number}-lead-${index}` }, [block.text || ""]);
}

function sheetMain(doc, page, navW) {
  const split = page.split || inferSplit(page, navW);
  const main = h("div", { class: "sheet-main" });
  main.style.setProperty("--split", (split * 100) + "%");
  const columns = sheetColumns(page);
  main.append(
    h("div", { class: "sheet-col left" }, columns.left.map((section) => sheetSection(doc, section))),
    sheetGutter(page, main, navW),
    h("div", { class: "sheet-col right" }, columns.right.map((section) => sheetSection(doc, section))),
  );
  return main;
}

function sheetGutter(page, main, navW) {
  const gutter = h("div", { class: "sheet-gutter", title: "Ширина колонок" });
  gutter.addEventListener("pointerdown", (event) => {
    const bounds = main.getBoundingClientRect();
    trackPointer(event, (ev) => {
      const ratio = clamp((ev.clientX - bounds.left) / bounds.width, 0.24, 0.76);
      page.split = ratio;
      main.style.setProperty("--split", (ratio * 100) + "%");
    }, () => scheduleSave());
  });
  gutter.dataset.nav = String(navW);
  return gutter;
}

function inferCut(page) {
  const regions = (page.regions || []).filter((region) => region.kind === "section");
  if (regions.length < 2) return page.width * 0.5;
  const edges = regions.map((region) => region.x).sort((a, b) => a - b);
  let gap = 0;
  let cut = page.width * 0.5;
  for (let index = 1; index < edges.length; index += 1) {
    const delta = edges[index] - edges[index - 1];
    if (delta > gap) {
      gap = delta;
      cut = edges[index];
    }
  }
  return cut;
}

function inferSplit(page, navW) {
  const content = Math.max(page.width - navW, 1);
  return clamp((inferCut(page) - navW) / content, 0.24, 0.76);
}

function sheetColumns(page) {
  const cut = inferCut(page);
  const left = [];
  const right = [];
  (page.sections || []).forEach((section, index) => {
    const region = (page.regions || []).find((item) => item.id === section.id);
    const side = section.column === "left" || section.column === "right"
      ? section.column
      : region && region.x >= cut - 6 ? "right" : "left";
    const bucket = side === "right" ? right : left;
    const stored = Number(section.y);
    bucket.push({ section, y: Number.isFinite(stored) ? stored : (region ? region.y : 100000 + index) });
  });
  left.sort((a, b) => a.y - b.y);
  right.sort((a, b) => a.y - b.y);
  return { left: left.map((item) => item.section), right: right.map((item) => item.section) };
}

function sheetSection(doc, section) {
  const titled = (section.title || "").trim();
  const filled = (section.blocks || []).length > 0;
  const node = h("section", {
    class: "sheet-sec" + (titled || filled ? "" : " is-empty"),
    "data-section": section.id,
  });
  const title = h("h3");
  if (sectionIconOn(section)) {
    if (section.icon) title.append(h("img", { src: media(doc, section.icon), alt: "" }));
    else title.append(h("span", { class: "sheet-mark" }));
  }
  title.append(h("span", { "data-bind": "sec-" + section.id }, [section.title || ""]));
  node.append(title);
  (section.blocks || []).forEach((block, index) => node.append(renderSheetBlock(doc, section, block, index)));
  return node;
}

function renderSheetBlock(doc, section, block, index) {
  if (block.type === "list") {
    return h("ul", null, (block.items || []).map((item, itemIndex) => h("li", {
      "data-bind": `item-${section.id}-${index}-${itemIndex}`,
    }, [item])));
  }
  if (block.type === "image") return h("img", { class: "sheet-inline", src: media(doc, block.src), alt: "" });
  if (block.type === "table") return sheetTable(section, index, block);
  const className = block.type === "note" ? "is-note" : block.type === "warning" ? "is-warn" : null;
  return h("p", { class: className, "data-bind": `blk-${section.id}-${index}` }, [block.text || ""]);
}

function sheetTable(section, index, table) {
  const key = section.id + "-" + index;
  const widths = columnWidths(table);
  const cols = widths.map((width) => h("col", { style: "width:" + width.toFixed(2) + "%" }));
  const head = h("tr", null, (table.headers || []).map((header, column) => h("th", {
    "data-bind": `th-${key}-${column}`,
  }, [header])));
  const body = h("tbody");
  (table.rows || []).forEach((row, rowIndex) => {
    body.append(h("tr", null, row.map((cell, column) => h("td", {
      "data-bind": `td-${key}-${rowIndex}-${column}`,
    }, [cell]))));
  });
  const tableNode = h("table", null, [
    h("colgroup", null, cols),
    h("thead", null, [head]),
    body,
  ]);
  const frame = h("div", { class: "sheet-table-frame" });
  frame.append(tableNode);
  const grips = [];
  for (let column = 0; column < widths.length - 1; column += 1) {
    const grip = h("i", { class: "col-grip", title: "Ширина столбца" });
    grip.addEventListener("pointerdown", (event) => resizeColumn(event, table, cols, grips, column));
    grips.push(grip);
    frame.append(grip);
  }
  placeColumnGrips(grips, widths);
  return frame;
}

function columnWidths(table) {
  const headers = table.headers || [];
  const stored = table.widths;
  if (Array.isArray(stored) && stored.length === headers.length && stored.every((value) => value > 0)) {
    const sum = stored.reduce((total, value) => total + value, 0);
    return stored.map((value) => (value / sum) * 100);
  }
  const weights = headers.map((header, index) => {
    const samples = [header, ...(table.rows || []).map((row) => row[index] || "")];
    let longest = 3;
    samples.forEach((sample) => {
      String(sample).split(/\s+/).forEach((word) => {
        if (word.length > longest) longest = word.length;
      });
    });
    return longest;
  });
  const sum = weights.reduce((total, value) => total + value, 0) || 1;
  return weights.map((weight) => (weight / sum) * 100);
}

function placeColumnGrips(grips, widths) {
  let at = 0;
  widths.forEach((width, index) => {
    at += width;
    if (grips[index]) grips[index].style.left = at + "%";
  });
}

function resizeColumn(event, table, cols, grips, index) {
  const frame = event.currentTarget.parentElement;
  const width = frame.getBoundingClientRect().width || 1;
  const start = columnWidths(table);
  const pair = start[index] + start[index + 1];
  const origin = event.clientX;
  event.currentTarget.classList.add("is-on");
  trackPointer(event, (ev) => {
    const next = start.slice();
    const left = clamp(start[index] + ((ev.clientX - origin) / width) * 100, 8, pair - 8);
    next[index] = left;
    next[index + 1] = pair - left;
    table.widths = next;
    next.forEach((value, column) => {
      cols[column].style.width = value.toFixed(2) + "%";
    });
    placeColumnGrips(grips, next);
  }, () => {
    event.currentTarget.classList.remove("is-on");
    scheduleSave();
  });
}

function docFontFamily(doc) {
  const font = (doc.fonts || []).find((item) => item.family);
  if (!font) return "";
  return String(font.family).replace(/[^\w -]/g, "");
}

function applyDocFonts(doc) {
  const fonts = doc.fonts || [];
  let style = document.getElementById("doc-fonts");
  if (!fonts.length) {
    if (style) style.remove();
    return;
  }
  if (!style) {
    style = document.createElement("style");
    style.id = "doc-fonts";
    document.head.append(style);
  }
  style.textContent = fonts.map((font) => {
    const family = String(font.family || "").replace(/[^\w -]/g, "");
    if (!family || !font.src) return "";
    const weight = Number(font.weight) || 400;
    return `@font-face{font-family:"${family}";font-style:normal;font-weight:${weight};font-display:swap;src:url("${media(doc, font.src)}") format("truetype");}`;
  }).join("");
}

function sheetFoot(doc) {
  const contacts = doc.contacts || {};
  const view = footView(contacts);
  const foot = h("footer", { class: "sheet-foot" });
  foot.append(h("p", {
    "data-bind": "foot-disclaimer",
    class: view.disclaimer ? "" : "is-empty",
  }, [view.disclaimer]));
  const support = h("p", { class: "sheet-support" });
  support.append(h("span", {
    "data-bind": "foot-support",
    class: view.support ? "" : "is-empty",
  }, [view.support]));
  support.append(h("a", {
    "data-bind": "foot-phone",
    class: view.phone ? "" : "is-empty",
    href: contacts.phoneHref || phoneHref(view.phone) || "tel:",
  }, [view.phone]));
  foot.append(support);
  const links = h("p", { class: "sheet-links" });
  links.append(h("a", {
    "data-bind": "foot-email",
    class: view.email ? "" : "is-empty",
    href: view.email ? "mailto:" + view.email : "mailto:",
  }, [view.email]));
  links.append(h("a", {
    "data-bind": "foot-site",
    class: view.site ? "" : "is-empty",
    href: contacts.siteHref || siteHref(view.site) || "#",
    target: "_blank",
    rel: "noopener",
  }, [view.site]));
  foot.append(links);
  return foot;
}

function sectionRegion(doc, page, frame, region) {
  const node = h("div", {
    class: "region is-section" + (regionMoved(region) ? " is-moved" : ""),
    "data-region": region.id,
    title: region.title || "Блок",
  });
  place(node, page, region);
  node.classList.toggle("is-on", state.selectedId === region.id);
  node.append(regionShot(doc, page, region));
  region.blockIds.forEach((id) => {
    const block = (page.layout || []).find((item) => item.id === id);
    if (block) node.append(layoutBlock(doc, page, frame, block, region));
  });
  ["nw", "ne", "sw", "se"].forEach((corner) => {
    const handle = h("i", { class: "handle handle-" + corner, title: "Изменить размер" });
    handle.addEventListener("pointerdown", (event) => resizeRegion(event, page, frame, region, node, corner));
    node.append(handle);
  });
  node.addEventListener("pointerdown", (event) => {
    if (event.target.classList.contains("handle")) return;
    selectRegion(node, region);
  });
  return node;
}

function regionShot(doc, page, region) {
  const origin = region.origin || region;
  const shot = h("div", { class: "region-shot" });
  const img = h("img", { src: media(doc, page.image), alt: "" });
  img.style.width = (page.width / origin.w) * 100 + "%";
  img.style.height = (page.height / origin.h) * 100 + "%";
  img.style.left = (-origin.x / origin.w) * 100 + "%";
  img.style.top = (-origin.y / origin.h) * 100 + "%";
  shot.append(img);
  return shot;
}

function layoutBlock(doc, page, frame, block, region) {
  const node = h("div", {
    class: "layout-block" + (block.type === "image" ? " is-image" : "") + (block.vertical ? " is-vertical" : ""),
    "data-block": block.id,
  });
  if (region) placeIn(node, region, block);
  else place(node, page, block);
  node.style.setProperty("--fg", block.color || "#1a242b");
  node.style.setProperty("--bg", block.bg || "#ffffff");
  node.style.setProperty("--size", block.size || 11);
  node.style.setProperty("--weight", block.bold ? "700" : "400");
  node.style.setProperty("--lh", lineHeight(block));
  const rewritten = block.type === "text" && (block.text || "") !== (block.original || "");
  node.classList.toggle("is-member", !!region);
  node.classList.toggle("is-rewritten", rewritten);
  node.classList.toggle("is-live", rewritten || imageDirty(block) || (!region && blockDirty(block)));
  node.classList.toggle("is-on", !region && state.selectedId === block.id);
  const query = state.query.toLowerCase();
  if (query && block.type === "text" && (block.text || "").toLowerCase().includes(query)) node.classList.add("is-hit");

  if (block.type === "image") {
    node.append(h("img", { src: media(doc, block.src), alt: "" }));
  } else {
    const text = h("div", { class: "text" });
    text.innerText = block.text || "";
    node.append(text);
  }
  if (!region) {
    ["nw", "ne", "sw", "se"].forEach((corner) => {
      const handle = h("i", { class: "handle handle-" + corner, title: "Изменить размер" });
      handle.addEventListener("pointerdown", (event) => resizeBlock(event, page, frame, block, node, corner));
      node.append(handle);
    });
  }
  return node;
}

function selectBlock(node, block) {
  state.selectedId = block.id;
  const frame = node.closest(".page");
  frame.querySelectorAll(".layout-block, .region").forEach((item) => item.classList.toggle("is-on", item === node));
}

function selectRegion(node, region) {
  state.selectedId = region.id;
  const frame = node.closest(".page");
  frame.querySelectorAll(".layout-block, .region").forEach((item) => item.classList.toggle("is-on", item === node));
}

function showBindings(bindings) {
  document.querySelectorAll("#pane-sheet .is-on").forEach((node) => node.classList.remove("is-on"));
  (bindings || []).forEach((binding) => {
    const region = (binding.page.regions || []).find((item) => item.kind === "section" && item.blockIds.includes(binding.id));
    const node = region
      ? document.querySelector(`#pane-sheet [data-region="${CSS.escape(region.id)}"]`)
      : document.querySelector(`#pane-sheet [data-block="${CSS.escape(binding.id)}"]`);
    if (node) node.classList.add("is-on");
  });
}

function resizeBlock(event, page, frame, block, node, corner) {
  selectBlock(node, block);
  const scale = pageScale(frame, page);
  const start = { x: event.clientX, y: event.clientY, bx: block.x, by: block.y, bw: block.w, bh: block.h };
  trackPointer(event, (ev) => {
    const dx = (ev.clientX - start.x) * scale.x;
    const dy = (ev.clientY - start.y) * scale.y;
    const next = resizeBox({ x: start.bx, y: start.by, w: start.bw, h: start.bh }, dx, dy, corner, 16, 10);
    block.x = next.x;
    block.y = next.y;
    block.w = next.w;
    block.h = next.h;
    place(node, page, block);
    fitBlockText(node, block, true);
    node.classList.add("is-live");
    renderMasks(frame, page);
  }, () => scheduleSave());
}

function resizeRegion(event, page, frame, region, node, corner) {
  selectRegion(node, region);
  const scale = pageScale(frame, page);
  const members = region.blockIds
    .map((id) => (page.layout || []).find((block) => block.id === id))
    .filter(Boolean)
    .map((block) => ({ block, x: block.x, y: block.y, w: block.w, h: block.h }));
  const start = { x: event.clientX, y: event.clientY, box: { x: region.x, y: region.y, w: region.w, h: region.h } };
  trackPointer(event, (ev) => {
    const dx = (ev.clientX - start.x) * scale.x;
    const dy = (ev.clientY - start.y) * scale.y;
    const next = resizeBox(start.box, dx, dy, corner, 48, 28);
    const sx = next.w / start.box.w;
    const sy = next.h / start.box.h;
    region.x = next.x;
    region.y = next.y;
    region.w = next.w;
    region.h = next.h;
    members.forEach((item) => {
      const rx = (item.x - start.box.x) / start.box.w;
      const ry = (item.y - start.box.y) / start.box.h;
      item.block.x = next.x + rx * next.w;
      item.block.y = next.y + ry * next.h;
      item.block.w = item.w * sx;
      item.block.h = item.h * sy;
      const child = node.querySelector(`[data-block="${CSS.escape(item.block.id)}"]`);
      if (!child) return;
      placeIn(child, region, item.block);
      fitBlockText(child, item.block, true);
    });
    place(node, page, region);
    node.classList.toggle("is-moved", regionMoved(region));
    renderMasks(frame, page);
  }, () => scheduleSave());
}

function resizeBox(start, dx, dy, corner, minW, minH) {
  let x = start.x;
  let y = start.y;
  let w = start.w;
  let h = start.h;
  if (corner.includes("e")) w = start.w + dx;
  if (corner.includes("s")) h = start.h + dy;
  if (corner.includes("w")) {
    w = start.w - dx;
    x = start.x + dx;
  }
  if (corner.includes("n")) {
    h = start.h - dy;
    y = start.y + dy;
  }
  if (w < minW) {
    if (corner.includes("w")) x -= minW - w;
    w = minW;
  }
  if (h < minH) {
    if (corner.includes("n")) y -= minH - h;
    h = minH;
  }
  return { x, y, w, h };
}

function trackPointer(event, onMove, onUp) {
  event.preventDefault();
  event.stopPropagation();
  const handle = event.currentTarget;
  try { handle.setPointerCapture(event.pointerId); } catch (error) { /* synthetic events have no capture */ }
  const move = (ev) => onMove(ev);
  const up = () => {
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", up);
    onUp();
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", up);
}

function renderMasks(frame, page) {
  const layer = frame.querySelector(".masks");
  if (!layer) return;
  const rects = [...(page.erasers || [])];
  (page.regions || []).forEach((region) => {
    if (region.kind === "section" && regionMoved(region)) rects.push({ ...region.origin, color: "#ffffff" });
  });
  (page.layout || []).forEach((block) => {
    const region = regionOf(page, block);
    if (region && regionMoved(region) && !textDirty(block) && !imageDirty(block)) return;
    if (block.origin && blockDirty(block)) rects.push({ ...block.origin, color: block.bg || "#ffffff" });
  });
  layer.replaceChildren(...rects.map((rect) => {
    const mask = h("div", { class: "mask" });
    place(mask, page, rect);
    mask.style.background = rect.color || "#ffffff";
    return mask;
  }));
}

function place(node, page, box) {
  node.style.left = (box.x / page.width) * 100 + "%";
  node.style.top = (box.y / page.height) * 100 + "%";
  node.style.width = (box.w / page.width) * 100 + "%";
  node.style.height = (box.h / page.height) * 100 + "%";
}

function placeIn(node, region, block) {
  node.style.left = ((block.x - region.x) / region.w) * 100 + "%";
  node.style.top = ((block.y - region.y) / region.h) * 100 + "%";
  node.style.width = (block.w / region.w) * 100 + "%";
  node.style.height = (block.h / region.h) * 100 + "%";
}

function placeBlock(node, page, block) {
  const host = node.parentElement;
  if (host && host.classList.contains("region")) {
    const region = (page.regions || []).find((item) => item.id === host.dataset.region);
    if (region) {
      placeIn(node, region, block);
      return;
    }
  }
  place(node, page, block);
}

function pageScale(frame, page) {
  const rect = frame.getBoundingClientRect();
  return { x: page.width / rect.width, y: page.height / rect.height };
}

function blockDirty(block) {
  if (block.added || !block.origin) return true;
  const origin = block.origin;
  const moved = ["x", "y", "w", "h"].some((key) => Math.abs(Number(block[key]) - Number(origin[key])) > 0.6);
  if (moved) return true;
  return textDirty(block) || imageDirty(block);
}

function textDirty(block) {
  return !!block && block.type === "text" && (block.text || "") !== (block.original || "");
}

function imageDirty(block) {
  return !!block && block.type === "image" && block.src !== block.originalSrc;
}

function textLeading(block) {
  if (!block) return 11;
  if (block.vertical) return Number(block.origin && block.origin.w) || Number(block.w) || Number(block.size) || 11;
  if (block.lead) return block.lead;
  const source = block.original != null ? block.original : block.text;
  const count = Math.max(1, String(source || "").split("\n").length);
  const height = Number((block.origin && block.origin.h) || block.h) || count * (Number(block.size) || 11);
  block.lead = height / count;
  return block.lead;
}

function keepMarker(original, next) {
  const marker = String(original || "").match(/^\s*[•·●]\s*/);
  const value = String(next || "");
  if (!marker || /^\s*[•·●]/.test(value)) return value;
  return marker[0].replace(/\s+$/, " ") + value.trim();
}

function lineHeight(block) {
  return textLeading(block);
}

function fitBlockText(node, block, crop) {
  if (!block || block.type !== "text") return;
  node.style.setProperty("--lh", String(lineHeight(block)));
  const text = node.querySelector(".text");
  if (!text || !text.clientWidth || !text.clientHeight) return;
  if (!block.vertical && !crop) {
    node.style.setProperty("--fit", "1");
    return;
  }
  let fit = 1;
  node.style.setProperty("--fit", "1");
  for (let guard = 0; guard < 8; guard += 1) {
    const box = text.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(text);
    const ink = range.getBoundingClientRect();
    const spillX = Math.max(box.left - ink.left, ink.right - box.right, 0);
    const spillY = Math.max(box.top - ink.top, ink.bottom - box.bottom, 0);
    const scaleX = spillX > 0.3 ? ((ink.width - spillX) / ink.width) * 0.97 : 1;
    const scaleY = spillY > 0.3 ? ((ink.height - spillY) / ink.height) * 0.97 : 1;
    const scale = Math.min(scaleX, scaleY);
    if (scale >= 1) break;
    fit = Math.max(fit * scale, 0.45);
    node.style.setProperty("--fit", String(fit));
    if (fit <= 0.45) break;
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function footBlock(doc) {
  const contacts = doc.contacts || (doc.contacts = {});
  const block = h("section", { class: "foot-block" });
  block.append(footField("Примечание", () => footView(contacts).disclaimer, (value) => {
    splitFoot(contacts);
    contacts.disclaimer = value;
    markFoot("foot-disclaimer", value);
  }, "Текст в подвале", "foot-disclaimer"));
  block.append(footField("Подпись", () => footView(contacts).support, (value) => {
    splitFoot(contacts);
    contacts.support = value;
    markFoot("foot-support", value);
  }, "Техническая поддержка", "foot-support"));
  block.append(footField("Телефон", () => contacts.phone || "", (value) => {
    contacts.phone = value;
    contacts.phoneHref = phoneHref(value);
    markFoot("foot-phone", value);
    setFootHref("foot-phone", contacts.phoneHref || "tel:");
  }, "8 (800) 000-00-00", "foot-phone"));
  block.append(footField("Почта", () => contacts.email || "", (value) => {
    contacts.email = value;
    markFoot("foot-email", value);
    setFootHref("foot-email", value ? "mailto:" + value : "mailto:");
  }, "name@example.ru", "foot-email"));
  block.append(footField("Сайт", () => contacts.site || "", (value) => {
    contacts.site = value;
    contacts.siteHref = siteHref(value);
    markFoot("foot-site", value);
    setFootHref("foot-site", contacts.siteHref || "#");
  }, "www.example.ru", "foot-site"));
  return block;
}

function footField(label, get, set, placeholder, bind) {
  return h("label", { class: "foot-field" }, [
    h("span", null, [label]),
    editable("p", "foot-line", get, set, placeholder, null, null, [], null, bind, "foot"),
  ]);
}

function footView(contacts) {
  const support = contacts.support != null ? contacts.support : "Техническая поддержка";
  let disclaimer = contacts.disclaimer || "";
  if (contacts.support == null && support && disclaimer.includes(support)) {
    disclaimer = disclaimer.replace(support, " ").replace(/\s+/g, " ").trim();
  }
  return {
    disclaimer,
    support,
    phone: contacts.phone || "",
    email: contacts.email || "",
    site: contacts.site || "",
  };
}

function splitFoot(contacts) {
  if (contacts.support != null) return;
  const mark = "Техническая поддержка";
  const text = contacts.disclaimer || "";
  if (text.includes(mark)) contacts.disclaimer = text.replace(mark, " ").replace(/\s+/g, " ").trim();
  contacts.support = mark;
}

function phoneHref(phone) {
  let digits = String(phone || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("8")) digits = "7" + digits.slice(1);
  return digits ? "tel:+" + digits : "";
}

function siteHref(site) {
  const value = String(site || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  return "https://" + value;
}

function markFoot(bind, value) {
  document.querySelectorAll(`#pane-sheet [data-bind="${CSS.escape(bind)}"]`).forEach((node) => {
    node.classList.toggle("is-empty", !String(value || "").trim());
  });
}

function setFootHref(bind, href) {
  document.querySelectorAll(`#pane-sheet [data-bind="${CSS.escape(bind)}"]`).forEach((node) => {
    node.setAttribute("href", href);
  });
}

function sectionMatches(section, query) {
  if (!query) return true;
  const hay = [
    section.title,
    ...section.blocks.flatMap((block) => [block.text || "", ...(block.items || []), ...((block.rows || []).flat())]),
  ].join(" ").toLowerCase();
  return hay.includes(query.toLowerCase());
}

function leadMatches(page, query) {
  if (!query) return true;
  return page.lead.some((block) => (block.text || "").toLowerCase().includes(query.toLowerCase()));
}

function figureMatches() {
  return !state.query;
}

function parseNum(value) {
  if (!/^\d+(?:[.,]\d+)?$/.test(String(value).trim())) return null;
  return Number(String(value).replace(",", "."));
}

function compareCell(a, b) {
  const left = parseNum(a);
  const right = parseNum(b);
  if (left != null && right != null) return left - right;
  return String(a || "").localeCompare(String(b || ""), "ru");
}

function watchSections() {
  observer?.disconnect();
  const buttons = [...document.querySelectorAll("#nav button[data-target]")];
  const sections = buttons
    .map((button) => document.getElementById(button.dataset.target))
    .filter(Boolean);
  if (!sections.length) return;
  observer = new IntersectionObserver((entries) => {
    const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (!visible) return;
    buttons.forEach((button) => button.classList.toggle("is-on", button.dataset.target === visible.target.id));
  }, { root: document.querySelector("#pane-text"), rootMargin: "-20% 0px -60% 0px", threshold: [0.1, 0.4] });
  sections.forEach((section) => observer.observe(section));
}

function marked(text, query) {
  const value = text || "";
  const fragment = document.createDocumentFragment();
  if (!query) {
    fragment.append(value);
    return fragment;
  }
  const re = new RegExp(escapeReg(query), "ig");
  let last = 0;
  for (const match of value.matchAll(re)) {
    fragment.append(value.slice(last, match.index));
    fragment.append(h("mark", null, [match[0]]));
    last = match.index + match[0].length;
  }
  fragment.append(value.slice(last));
  return fragment;
}

function media(doc, src) {
  const clean = String(src || "").split("?")[0];
  return "/media/" + encodeURIComponent(doc.id) + "/" + clean.split("/").map(encodeURIComponent).join("/");
}

let saveTimer = null;
let sheetObservers = [];

function setStatus(text) {
  const node = document.querySelector("#save-state");
  if (node) node.textContent = text;
}

function scheduleSave() {
  setStatus("Правки…");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveDocument().catch((error) => setStatus(error.message));
  }, 400);
}

async function saveDocument() {
  clearTimeout(saveTimer);
  const doc = state.doc;
  if (!doc) return;
  setStatus("Сохраняем…");
  await getJSON("/api/docs/" + encodeURIComponent(doc.id) + "/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(doc),
  });
  setStatus("Сохранено");
}

async function exportPdf() {
  const button = document.querySelector("#export-pdf");
  if (button) button.disabled = true;
  try {
    await saveDocument();
    const response = await fetch("/api/docs/" + encodeURIComponent(state.doc.id) + "/export.pdf");
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "Не удалось собрать PDF.");
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = (state.doc.title || "document") + ".pdf";
    link.click();
    URL.revokeObjectURL(url);
    setStatus("PDF готов");
  } catch (error) {
    setStatus(error.message);
  } finally {
    if (button) button.disabled = false;
  }
}

function pickImage(done) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/png,image/jpeg,image/webp";
  input.addEventListener("change", async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    const body = new FormData();
    body.append("file", file, file.name);
    try {
      const result = await getJSON("/api/docs/" + encodeURIComponent(state.doc.id) + "/image", {
        method: "POST",
        body,
      });
      done(result.src);
    } catch (error) {
      setStatus(error.message);
    }
  });
  input.click();
}

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + " КБ";
  return (bytes / 1024 / 1024).toFixed(1) + " МБ";
}

async function convertFile(file) {
  const body = new FormData();
  body.append("file", file, file.name);
  await convert(body);
}

async function convertLocal(name) {
  await convert(JSON.stringify({ local: name }), "application/json");
}

async function convert(body, contentType) {
  state.busy = true;
  state.error = "";
  render();
  try {
    const headers = contentType ? { "Content-Type": contentType } : undefined;
    const result = await getJSON("/api/convert", { method: "POST", body, headers });
    state.busy = false;
    location.hash = "#/doc/" + encodeURIComponent(result.id);
  } catch (error) {
    state.error = error.message;
    state.busy = false;
    render();
  }
}

async function getJSON(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Запрос не выполнен.");
  return data;
}

function escapeReg(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function h(tag, props, children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children || []) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}
