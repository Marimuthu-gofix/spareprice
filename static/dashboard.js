(function () {
  const seriesNode = document.getElementById("spareprice-series");
  const series = seriesNode ? JSON.parse(seriesNode.textContent || "[]") : [];
  const svg = document.getElementById("trendChart");
  const chartLegend = document.getElementById("chartLegend");
  const jobButtons = [...document.querySelectorAll("[data-job-button]")];
  const jobStatus = document.getElementById("jobStatus");
  const topLoader = document.getElementById("topLoader");
  const colors = ["#2563eb", "#0f8f68", "#b45309", "#7c3aed", "#dc2626", "#0891b2"];

  // ---------- top loading bar on full-page navigation ----------
  function showTopLoader() {
    if (topLoader) topLoader.classList.add("active");
  }
  document.querySelectorAll("a[href]:not([target='_blank'])").forEach((link) => {
    link.addEventListener("click", showTopLoader);
  });
  document.querySelectorAll("form").forEach((form) => {
    if (form.hasAttribute("data-job-form-skip")) return;
    const submitButton = form.querySelector("[data-job-button]");
    if (submitButton) return; // handled separately via fetch
    form.addEventListener("submit", showTopLoader);
  });

  // ---------- dynamic sticky offsets ----------
  // The topbar and filter-bar heights vary with content (job status, hosted
  // vs. live actions, wrapped filter rows on narrow screens), so measure the
  // rendered heights instead of guessing fixed pixel offsets that drift out
  // of sync and make the sticky table header overlap rows.
  function updateStickyOffsets() {
    const topbar = document.querySelector(".topbar");
    const filterBar = document.querySelector(".filter-bar:not(.filter-bar-compact)");
    const filterBarCompact = document.querySelector(".filter-bar-compact");
    const root = document.documentElement.style;
    if (topbar) root.setProperty("--topbar-h", `${topbar.offsetHeight}px`);
    if (filterBar) root.setProperty("--filter-h", `${filterBar.offsetHeight}px`);
    if (filterBarCompact) root.setProperty("--filter-compact-h", `${filterBarCompact.offsetHeight}px`);
  }
  updateStickyOffsets();
  window.addEventListener("resize", updateStickyOffsets);
  window.addEventListener("load", updateStickyOffsets);

  // ---------- refresh button ----------
  const refreshButton = document.querySelector("[data-action='refresh']");
  if (refreshButton) {
    refreshButton.addEventListener("click", () => {
      showTopLoader();
      window.location.reload();
    });
  }

  // ---------- row details drawer ----------
  // Each row-toggle is followed by an inert <template> holding its detail
  // markup (server-rendered, so links/text stay escaped correctly); clicking
  // the row clones that template into a shared slide-in drawer instead of
  // expanding an inline row, so the table stops jumping around as you browse.
  const drawer = document.getElementById("detailDrawer");
  const drawerBackdrop = document.getElementById("drawerBackdrop");
  const drawerTitle = document.getElementById("drawerTitle");
  const drawerBody = document.getElementById("drawerBody");
  const drawerClose = document.getElementById("drawerClose");
  let activeDrawerRow = null;

  function openDrawer(row, template) {
    if (activeDrawerRow) activeDrawerRow.classList.remove("expanded");
    activeDrawerRow = row;
    row.classList.add("expanded");
    drawerTitle.innerHTML = row.dataset.drawerTitle || "Details";
    drawerBody.innerHTML = "";
    drawerBody.appendChild(template.content.cloneNode(true));
    drawer.hidden = false;
    drawerBackdrop.hidden = false;
    drawer.setAttribute("aria-hidden", "false");
    requestAnimationFrame(() => {
      drawer.classList.add("open");
      drawerBackdrop.classList.add("open");
    });
  }

  function closeDrawer() {
    if (activeDrawerRow) activeDrawerRow.classList.remove("expanded");
    activeDrawerRow = null;
    drawer.classList.remove("open");
    drawerBackdrop.classList.remove("open");
    drawer.setAttribute("aria-hidden", "true");
    window.setTimeout(() => {
      if (!drawer.classList.contains("open")) {
        drawer.hidden = true;
        drawerBackdrop.hidden = true;
      }
    }, 200);
  }

  document.querySelectorAll("tr.row-toggle").forEach((row) => {
    const template = row.nextElementSibling;
    if (!template || template.tagName !== "TEMPLATE") return;
    const toggle = () => {
      if (activeDrawerRow === row) {
        closeDrawer();
      } else {
        openDrawer(row, template);
      }
    };
    row.addEventListener("click", (event) => {
      if (event.target.closest("a")) return;
      toggle();
    });
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggle();
      }
    });
  });

  if (drawerClose) drawerClose.addEventListener("click", closeDrawer);
  if (drawerBackdrop) drawerBackdrop.addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && activeDrawerRow) closeDrawer();
  });

  // ---------- model accordions ----------
  // Consecutive same-model rows are tagged group-header/group-child by
  // dashboard.py; the header toggles its members' [hidden] attribute
  // (collapsed by default) instead of navigating anywhere.
  const groupHeaders = [...document.querySelectorAll("tr.group-header")];
  const toggleGroupsButton = document.getElementById("toggleGroupsButton");

  function setGroupExpanded(header, expanded) {
    header.classList.toggle("expanded", expanded);
    header.setAttribute("aria-expanded", expanded ? "true" : "false");
    const groupId = header.dataset.group;
    document.querySelectorAll(`tr.row-toggle[data-group="${groupId}"]`).forEach((row) => {
      row.hidden = !expanded;
      if (!expanded && activeDrawerRow === row) closeDrawer();
    });
  }

  groupHeaders.forEach((header) => {
    const toggle = () => setGroupExpanded(header, !header.classList.contains("expanded"));
    header.addEventListener("click", toggle);
    header.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggle();
      }
    });
  });

  if (toggleGroupsButton && groupHeaders.length) {
    toggleGroupsButton.hidden = false;
    toggleGroupsButton.textContent = toggleGroupsButton.dataset.collapsedLabel;
    toggleGroupsButton.addEventListener("click", () => {
      const willExpand = toggleGroupsButton.textContent === toggleGroupsButton.dataset.collapsedLabel;
      groupHeaders.forEach((header) => setGroupExpanded(header, willExpand));
      toggleGroupsButton.textContent = willExpand
        ? toggleGroupsButton.dataset.expandedLabel
        : toggleGroupsButton.dataset.collapsedLabel;
    });
  }

  function draw() {
    if (!svg) return;
    const width = svg.clientWidth || 900;
    const height = svg.clientHeight || 320;
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.innerHTML = "";

    const margin = { top: 18, right: 28, bottom: 42, left: 82 };
    const plotW = width - margin.left - margin.right;
    const plotH = height - margin.top - margin.bottom;
    const points = series.flatMap((item) =>
      item.points.map((point) => ({
        label: item.label,
        date: new Date(point.date),
        value: Number(point.value),
        price: point.price,
      }))
    ).filter((point) => Number.isFinite(point.value) && !Number.isNaN(point.date.getTime()));

    if (!points.length) {
      addText("No price history yet", width / 2, height / 2, "middle", "empty-chart");
      return;
    }

    const minDate = new Date(Math.min(...points.map((point) => point.date.getTime())));
    const maxDate = new Date(Math.max(...points.map((point) => point.date.getTime())));
    const minValue = Math.min(...points.map((point) => point.value));
    const maxValue = Math.max(...points.map((point) => point.value));
    const valuePad = Math.max((maxValue - minValue) * 0.12, 100);
    const yMin = Math.max(0, minValue - valuePad);
    const yMax = maxValue + valuePad;
    const dateSpan = Math.max(maxDate.getTime() - minDate.getTime(), 1);
    const valueSpan = Math.max(yMax - yMin, 1);

    const x = (date) => margin.left + ((date.getTime() - minDate.getTime()) / dateSpan) * plotW;
    const y = (value) => margin.top + plotH - ((value - yMin) / valueSpan) * plotH;

    addLine(margin.left, margin.top, margin.left, margin.top + plotH, "#cbd5e1");
    addLine(margin.left, margin.top + plotH, margin.left + plotW, margin.top + plotH, "#cbd5e1");

    for (let i = 0; i <= 4; i += 1) {
      const value = yMin + (valueSpan * i) / 4;
      const yy = y(value);
      addLine(margin.left, yy, margin.left + plotW, yy, "#eef2f7");
      addText(`Rs ${Math.round(value).toLocaleString("en-IN")}`, margin.left - 10, yy + 4, "end", "axis-label");
    }

    addText(formatDate(minDate), margin.left, height - 22, "start", "axis-label");
    addText(formatDate(maxDate), margin.left + plotW, height - 22, "end", "axis-label");

    series.forEach((item, index) => {
      const valid = item.points
        .map((point) => ({ date: new Date(point.date), value: Number(point.value), price: point.price }))
        .filter((point) => Number.isFinite(point.value) && !Number.isNaN(point.date.getTime()))
        .sort((a, b) => a.date - b.date);
      if (!valid.length) return;

      const color = colors[index % colors.length];
      const path = valid.map((point, pointIndex) => `${pointIndex ? "L" : "M"} ${x(point.date)} ${y(point.value)}`).join(" ");
      addPath(path, color);
      valid.forEach((point) => addDot(x(point.date), y(point.value), color, `${item.label}: ${point.price}`));
    });

    drawLegend();
  }

  function addLine(x1, y1, x2, y2, stroke) {
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", x1);
    line.setAttribute("y1", y1);
    line.setAttribute("x2", x2);
    line.setAttribute("y2", y2);
    line.setAttribute("stroke", stroke);
    svg.appendChild(line);
  }

  function addPath(d, stroke) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", stroke);
    path.setAttribute("stroke-width", "3");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.appendChild(path);
  }

  function addDot(cx, cy, fill, label) {
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", cx);
    circle.setAttribute("cy", cy);
    circle.setAttribute("r", "5");
    circle.setAttribute("fill", fill);
    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.textContent = label;
    circle.appendChild(title);
    svg.appendChild(circle);
  }

  function addText(text, x, y, anchor, className) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", "text");
    node.textContent = text;
    node.setAttribute("x", x);
    node.setAttribute("y", y);
    node.setAttribute("text-anchor", anchor);
    node.setAttribute("class", className);
    svg.appendChild(node);
  }

  function drawLegend() {
    if (!chartLegend) return;
    chartLegend.innerHTML = "";
    series.forEach((item, index) => {
      const entry = document.createElement("span");
      entry.className = "legend-entry";
      entry.innerHTML = `<i style="background:${colors[index % colors.length]}"></i>${escapeHtml(item.label)}`;
      chartLegend.appendChild(entry);
    });
  }

  function formatDate(date) {
    return date.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
  }

  window.addEventListener("resize", draw);
  draw();

  jobButtons.forEach((button) => {
    button.closest("form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = button.closest("form");
      setButtonsDisabled(true);
      button.textContent = button.dataset.runningLabel || "Working...";
      setJobStatus(button.dataset.startLabel || "Working...", "This can take a few minutes.", true);
      await fetch(form.action, { method: "POST", headers: { Accept: "application/json" }, body: new FormData(form) });
      pollJob();
    });
  });

  if (jobStatus && jobStatus.dataset.running === "true") {
    pollJob();
  }

  async function pollJob() {
    const response = await fetch("/job-status");
    const state = await response.json();
    setJobStatus(
      state.message,
      state.finished_at
        ? `Finished ${formatStatusDate(state.finished_at)} | Took ${formatDurationBetween(state.started_at, state.finished_at)}`
        : formatProgress(state.progress, state.started_at),
      state.running,
      state.running && state.progress ? state.progress.percent : undefined
    );
    if (state.running) {
      window.setTimeout(pollJob, 3000);
      return;
    }
    setButtonsDisabled(false);
    window.setTimeout(() => window.location.reload(), 1200);
  }

  function setButtonsDisabled(disabled) {
    jobButtons.forEach((button) => {
      button.disabled = disabled;
      if (!disabled) {
        button.textContent = button.dataset.idleLabel || (button.id === "checkAllButton" ? "Check All Prices" : "Discover All Mobiles");
      }
    });
  }

  // percent (optional): when the job reports one, the bar fills to it;
  // otherwise the bar slides to show that something is happening.
  function setJobStatus(message, detail, running, percent) {
    if (!jobStatus) return;
    jobStatus.classList.toggle("running", running);
    jobStatus.dataset.running = running ? "true" : "false";
    const known = percent !== undefined && percent !== null && Number.isFinite(Number(percent));
    const width = known ? Math.max(0, Math.min(100, Number(percent))) : 0;
    const bar = running
      ? `<div class="job-bar${known ? " determinate" : ""}"${known ? ` style="--job-pct: ${width}%"` : ""}><i></i></div>`
      : "";
    jobStatus.innerHTML =
      `<div class="job-status-text"><strong>${escapeHtml(message)}</strong><span>${escapeHtml(detail)}</span></div>${bar}`;
  }

  function formatStatusDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
      timeZone: "Asia/Kolkata",
    });
  }

  function formatProgress(progress, startedAt) {
    if (!progress) return "Still running...";
    // A job that reports a percentage shows that instead of the step text.
    const hasPercent = progress.percent !== undefined && progress.percent !== null && Number.isFinite(Number(progress.percent));
    const parts = [];
    if (hasPercent) parts.push(`Progress: ${Math.round(Number(progress.percent))}%`);
    parts.push(`Time: ${formatElapsed(startedAt)}`);
    if (!hasPercent) parts.push(`Done: ${Number(progress.done || 0)} models`);
    parts.push(`Rows saved: ${Number(progress.rows || 0)}`);
    parts.push(`Errors: ${Number(progress.errors || 0)}`);
    if (!hasPercent && progress.current) parts.push(`Current: ${progress.current}`);
    return parts.join(" | ");
  }

  function formatElapsed(startedAt) {
    if (!startedAt) return "0s";
    const start = new Date(startedAt);
    if (Number.isNaN(start.getTime())) return "0s";
    return formatDurationMs(Date.now() - start.getTime());
  }

  function formatDurationBetween(startedAt, finishedAt) {
    const start = new Date(startedAt || "");
    const finish = new Date(finishedAt || "");
    if (Number.isNaN(start.getTime()) || Number.isNaN(finish.getTime())) return "-";
    return formatDurationMs(finish.getTime() - start.getTime());
  }

  function formatDurationMs(milliseconds) {
    const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours) return `${hours}h ${minutes}m ${seconds}s`;
    if (minutes) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }
})();

// The export picker's model list is large, so it is fetched the first time the
// export menu opens instead of being embedded in every page.
(function () {
  const menu = document.querySelector("details.export-menu");
  const list = document.getElementById("exportModelOptions");
  if (!menu || !list || !list.dataset.source) return;
  let loaded = false;
  menu.addEventListener("toggle", async () => {
    if (!menu.open || loaded) return;
    loaded = true;
    try {
      const names = await (await fetch(list.dataset.source)).json();
      const fragment = document.createDocumentFragment();
      names.forEach((name) => {
        const option = document.createElement("option");
        option.value = name;
        fragment.appendChild(option);
      });
      list.appendChild(fragment);
    } catch (error) {
      loaded = false;
    }
  });
})();

// Header dropdowns (export, user): only one open at a time, and a click
// anywhere else closes them.
(function () {
  const menus = [...document.querySelectorAll("details.export-menu")];
  if (!menus.length) return;
  menus.forEach((menu) => {
    menu.addEventListener("toggle", () => {
      if (!menu.open) return;
      menus.forEach((other) => {
        if (other !== menu) other.open = false;
      });
    });
  });
  document.addEventListener("click", (event) => {
    menus.forEach((menu) => {
      if (menu.open && !menu.contains(event.target)) menu.open = false;
    });
  });
})();
