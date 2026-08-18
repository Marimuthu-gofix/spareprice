(function () {
  const seriesNode = document.getElementById("spareprice-series");
  const series = seriesNode ? JSON.parse(seriesNode.textContent || "[]") : [];
  const svg = document.getElementById("trendChart");
  const chartLegend = document.getElementById("chartLegend");
  const jobButtons = [...document.querySelectorAll("[data-job-button]")];
  const jobStatus = document.getElementById("jobStatus");
  const colors = ["#2563eb", "#0f8f68", "#b45309", "#7c3aed", "#dc2626", "#0891b2"];

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
      state.finished_at ? `Finished ${formatStatusDate(state.finished_at)}` : formatProgress(state.progress),
      state.running
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

  function setJobStatus(message, detail, running) {
    if (!jobStatus) return;
    jobStatus.classList.toggle("running", running);
    jobStatus.dataset.running = running ? "true" : "false";
    jobStatus.innerHTML = `<strong>${escapeHtml(message)}</strong><span>${escapeHtml(detail)}</span>`;
  }

  function formatStatusDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  }

  function formatProgress(progress) {
    if (!progress) return "Still running...";
    const parts = [`Done: ${Number(progress.done || 0)} models`];
    parts.push(`Rows saved: ${Number(progress.rows || 0)}`);
    parts.push(`Errors: ${Number(progress.errors || 0)}`);
    if (progress.current) parts.push(`Current: ${progress.current}`);
    return parts.join(" | ");
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
