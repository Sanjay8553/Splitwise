const STORAGE_KEY = "wayfarer.data.v1";
const GOOGLE_SCOPE = "https://www.googleapis.com/auth/drive.appdata";
const DRIVE_FILE_NAME = "wayfarer-travel-expenses.json";
const CURRENCY_DIGITS = new Set(["JPY"]);

const ui = {
  connectButton: document.querySelector("#connect-drive"),
  syncStatus: document.querySelector("#sync-status"),
  tripList: document.querySelector("#trip-list"),
  tripContent: document.querySelector("#trip-content"),
  tripDialog: document.querySelector("#trip-dialog"),
  tripForm: document.querySelector("#trip-form"),
  tripError: document.querySelector("#trip-error"),
  expenseDialog: document.querySelector("#expense-dialog"),
  expenseForm: document.querySelector("#expense-form"),
  splitFields: document.querySelector("#split-fields"),
  expenseError: document.querySelector("#expense-error"),
  peopleDialog: document.querySelector("#people-dialog"),
  peopleForm: document.querySelector("#people-form"),
  peopleList: document.querySelector("#people-list"),
  peopleError: document.querySelector("#people-error"),
  settlementDialog: document.querySelector("#settlement-dialog"),
  settlementForm: document.querySelector("#settlement-form"),
  settlementError: document.querySelector("#settlement-error"),
  toast: document.querySelector("#toast"),
};

let data = loadLocalData();
let activeTripId = data.activeTripId ?? data.trips[0]?.id ?? null;
let accessToken = null;
let tokenExpiresAt = 0;
let driveFile = null;
let driveBaselineModifiedTime = null;
let dirty = false;
let toastTimer = null;
let editingExpenseId = null;
let editingTripId = null;
let editingSettlementId = null;

function makeId() {
  return crypto.randomUUID();
}

function emptyData() {
  return { schemaVersion: 1, updatedAt: new Date().toISOString(), activeTripId: null, trips: [] };
}

function loadLocalData() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return emptyData();
    const parsed = JSON.parse(stored);
    if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.trips)) throw new Error("Unsupported saved-data format.");
    return parsed;
  } catch (error) {
    console.error("Could not read saved trip data.", error);
    showToast("Saved data could not be read. Your original browser data was left untouched.");
    return emptyData();
  }
}

function saveLocalData(markDirty = true) {
  data.activeTripId = activeTripId;
  data.updatedAt = new Date().toISOString();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    if (markDirty) dirty = true;
    updateSyncStatus();
  } catch (error) {
    console.error("Could not save trip data.", error);
    showToast("Could not save this change on your device. Check available browser storage.");
    throw error;
  }
}

function showToast(message) {
  ui.toast.textContent = message;
  ui.toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.remove("is-visible"), 4200);
}

function updateSyncStatus(message, kind = "") {
  if (message) ui.syncStatus.textContent = message;
  else if (dirty) ui.syncStatus.textContent = accessToken ? "Changes not synced" : "Saved on this device";
  else ui.syncStatus.textContent = driveBaselineModifiedTime ? "Synced with Google Drive" : "Saved on this device";
  ui.syncStatus.classList.toggle("is-warning", kind === "warning" || dirty);
  ui.syncStatus.classList.toggle("is-error", kind === "error");
  ui.connectButton.textContent = accessToken ? (dirty ? "Sync changes" : "Sync Google Drive") : "Connect Google Drive";
}

function pruneExpiredTrips() {
  const now = Date.now();
  const kept = data.trips.filter((trip) => {
    if (!trip.endDate) return true;
    const expiry = Date.parse(`${trip.endDate}T00:00:00Z`) + 30 * 24 * 60 * 60 * 1000;
    return now < expiry;
  });
  if (kept.length === data.trips.length) return false;
  const removed = data.trips.length - kept.length;
  data.trips = kept;
  if (!kept.some((trip) => trip.id === activeTripId)) activeTripId = kept[0]?.id ?? null;
  saveLocalData();
  showToast(`${removed} trip${removed === 1 ? "" : "s"} older than 30 days was removed from this device. Sync Google Drive to remove it there too.`);
  return true;
}

function activeTrip() {
  return data.trips.find((trip) => trip.id === activeTripId) ?? null;
}

function activePeople(trip) {
  return trip.people.filter((person) => person.active !== false);
}

function expensePeople(trip, expense = null) {
  const allowed = new Set(activePeople(trip).map((person) => person.id));
  if (expense) {
    allowed.add(expense.paidBy);
    for (const personId of Object.keys(expense.shares ?? {})) allowed.add(personId);
    for (const item of expense.items ?? []) {
      for (const personId of Object.keys(item.shares ?? {})) allowed.add(personId);
    }
  }
  return trip.people.filter((person) => allowed.has(person.id));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function formatMoney(cents, currency) {
  const divisor = CURRENCY_DIGITS.has(currency) ? 1 : 100;
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    minimumFractionDigits: CURRENCY_DIGITS.has(currency) ? 0 : 2,
    maximumFractionDigits: CURRENCY_DIGITS.has(currency) ? 0 : 2,
  }).format(cents / divisor);
}

function amountToCents(raw, currency) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value * (CURRENCY_DIGITS.has(currency) ? 1 : 100));
}

function centsToInput(cents, currency) {
  return (cents / (CURRENCY_DIGITS.has(currency) ? 1 : 100)).toFixed(CURRENCY_DIGITS.has(currency) ? 0 : 2);
}

function formatDate(dateString, options = { month: "short", day: "numeric", year: "numeric" }) {
  if (!dateString) return "";
  return new Intl.DateTimeFormat(undefined, { ...options, timeZone: "UTC" }).format(new Date(`${dateString}T00:00:00Z`));
}

function makeShares(total, weights) {
  const entries = Object.entries(weights).filter(([, weight]) => Number.isFinite(weight) && weight > 0);
  const sum = entries.reduce((acc, [, weight]) => acc + weight, 0);
  if (!sum || total < 0) throw new Error("Choose at least one person and enter a positive share.");
  const rows = entries.map(([personId, weight]) => {
    const exact = total * weight / sum;
    return { personId, cents: Math.floor(exact), fraction: exact - Math.floor(exact) };
  });
  let remaining = total - rows.reduce((acc, row) => acc + row.cents, 0);
  rows.sort((a, b) => b.fraction - a.fraction || a.personId.localeCompare(b.personId));
  for (let i = 0; i < remaining; i += 1) rows[i % rows.length].cents += 1;
  return Object.fromEntries(rows.filter((row) => row.cents > 0).map((row) => [row.personId, row.cents]));
}

function splitEqual(total, peopleIds) {
  return makeShares(total, Object.fromEntries(peopleIds.map((id) => [id, 1])));
}

function tripBalances(trip) {
  const balances = Object.fromEntries(trip.people.map((person) => [person.id, {}]));
  for (const expense of trip.expenses) {
    if (!balances[expense.paidBy]) continue;
    balances[expense.paidBy][expense.currency] = (balances[expense.paidBy][expense.currency] ?? 0) + expense.amountCents;
    for (const [personId, cents] of Object.entries(expense.shares)) {
      if (!balances[personId]) continue;
      balances[personId][expense.currency] = (balances[personId][expense.currency] ?? 0) - cents;
    }
  }
  for (const settlement of trip.settlements) {
    if (balances[settlement.from]) balances[settlement.from][settlement.currency] = (balances[settlement.from][settlement.currency] ?? 0) + settlement.amountCents;
    if (balances[settlement.to]) balances[settlement.to][settlement.currency] = (balances[settlement.to][settlement.currency] ?? 0) - settlement.amountCents;
  }
  return balances;
}

function tripTotals(trip) {
  return trip.expenses.reduce((totals, expense) => {
    totals[expense.currency] = (totals[expense.currency] ?? 0) + expense.amountCents;
    return totals;
  }, {});
}

function render() {
  renderTripList();
  const trip = activeTrip();
  if (!trip) {
    ui.tripContent.innerHTML = `
      <div class="welcome">
        <div class="welcome-illustration" aria-hidden="true">✈</div>
        <p class="eyebrow">Less math, more memories</p>
        <h2>Your next trip, <span class="accent">all squared away.</span></h2>
        <p>Keep travel costs in one tidy place. Add the people, log the bills, and see who owes what — without passing a spreadsheet around.</p>
        <button class="button button-primary" type="button" data-action="new-trip">Create your first trip</button>
      </div>`;
    return;
  }
  renderTrip(trip);
}

function renderTripList() {
  if (!data.trips.length) {
    ui.tripList.innerHTML = `<div class="trip-list-empty">Your trips will show up here.</div>`;
    return;
  }
  ui.tripList.innerHTML = data.trips
    .slice()
    .sort((a, b) => b.startDate.localeCompare(a.startDate))
    .map((trip) => `
      <button class="trip-nav ${trip.id === activeTripId ? "is-active" : ""}" type="button" data-trip-id="${escapeHtml(trip.id)}">
        <span class="trip-nav-icon" aria-hidden="true">${trip.emoji || "✈"}</span>
        <span><strong>${escapeHtml(trip.name)}</strong><small>${escapeHtml(trip.destination || formatDate(trip.startDate))}</small></span>
      </button>`)
    .join("");
}

function renderTrip(trip) {
  const balances = tripBalances(trip);
  const totals = tripTotals(trip);
  const totalAmount = Object.entries(totals).map(([currency, cents]) => formatMoney(cents, currency)).join(" · ") || formatMoney(0, trip.currency);
  const balanceCurrencies = [...new Set(Object.values(balances).flatMap((personBalances) => Object.keys(personBalances)))];
  const expenseRows = trip.expenses.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const expenseList = expenseRows.length
    ? expenseRows.map((expense) => {
      const payer = trip.people.find((person) => person.id === expense.paidBy)?.name ?? "Unknown";
      const splitCount = Object.keys(expense.shares).length;
      return `<li class="expense-row" data-expense-id="${escapeHtml(expense.id)}">
        <span class="expense-icon" aria-hidden="true">${expense.method === "items" ? "▤" : "↗"}</span>
        <span class="expense-description"><strong>${escapeHtml(expense.description)}</strong><small>Paid by ${escapeHtml(payer)} · ${splitCount} ${splitCount === 1 ? "person" : "people"} · ${escapeHtml(expense.methodLabel)}${expense.items?.length ? ` · ${expense.items.length} items` : ""}</small></span>
        <span class="expense-amount"><strong>${formatMoney(expense.amountCents, expense.currency)}</strong><small>${formatDate(expense.date)}</small></span>
        <span class="expense-actions">
          <button class="row-action" type="button" data-action="edit-expense" data-expense-id="${escapeHtml(expense.id)}" aria-label="Edit ${escapeHtml(expense.description)}" title="Edit expense">Edit</button>
          <button class="row-action row-action-danger" type="button" data-action="delete-expense" data-expense-id="${escapeHtml(expense.id)}" aria-label="Delete ${escapeHtml(expense.description)}" title="Delete expense">Delete</button>
        </span>
      </li>`;
    }).join("")
    : `<li class="empty-row">No expenses yet. Add your first bill when you’re ready.</li>`;
  const balancesContent = trip.people.map((person) => {
    const personBalances = balances[person.id] ?? {};
    const amounts = balanceCurrencies.map((currency) => {
      const amount = personBalances[currency] ?? 0;
      const className = amount > 0 ? "positive" : amount < 0 ? "negative" : "zero";
      return `<span class="${className}">${amount > 0 ? "+" : ""}${formatMoney(amount, currency)}</span>`;
    }).join(" ");
    return `<li class="balance-row"><span class="balance-name"><span class="avatar">${escapeHtml(person.name.trim().slice(0, 1).toUpperCase())}</span>${escapeHtml(person.name)}${person.active === false ? ` <small class="inactive-person">(removed)</small>` : ""}</span><span class="balance-amount">${amounts || `<span class="zero">${formatMoney(0, trip.currency)}</span>`}</span></li>`;
  }).join("");
  const settlementRows = trip.settlements.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((settlement) => {
    const from = trip.people.find((person) => person.id === settlement.from)?.name ?? "Someone";
    const to = trip.people.find((person) => person.id === settlement.to)?.name ?? "someone";
    return `<li class="settlement-row">
      <span>${escapeHtml(from)} paid ${escapeHtml(to)} ${formatMoney(settlement.amountCents, settlement.currency)}</span>
      <span class="settlement-actions">
        <button class="row-action" type="button" data-action="edit-settlement" data-settlement-id="${escapeHtml(settlement.id)}">Edit</button>
        <button class="row-action row-action-danger" type="button" data-action="delete-settlement" data-settlement-id="${escapeHtml(settlement.id)}">Delete</button>
      </span>
    </li>`;
  }).join("");
  const formattedDates = `${formatDate(trip.startDate)} – ${formatDate(trip.endDate)}`;
  const participantsLabel = `${activePeople(trip).length} ${activePeople(trip).length === 1 ? "person" : "people"}`;
  const currencies = Object.keys(totals).length ? `${Object.keys(totals).length} ${Object.keys(totals).length === 1 ? "currency" : "currencies"}` : "No bills yet";

  ui.tripContent.innerHTML = `
    <div class="trip-header">
      <div>
        <p class="eyebrow">${escapeHtml(trip.destination || "Your trip")}</p>
        <h2>${escapeHtml(trip.name)}</h2>
        <div class="trip-meta"><span>◷ ${formattedDates}</span><span>♙ ${participantsLabel}</span><span>◎ ${escapeHtml(trip.currency)} home currency</span></div>
      </div>
      <div class="trip-actions">
        <button class="button button-quiet" type="button" data-action="edit-trip">Edit trip</button>
        <button class="button button-quiet button-danger" type="button" data-action="delete-trip">Delete trip</button>
        <button class="button button-quiet" type="button" data-action="add-person">Manage people</button>
        <button class="button button-quiet" type="button" data-action="add-settlement">Record payment</button>
        <button class="button button-primary" type="button" data-action="add-expense">+ Expense</button>
      </div>
    </div>
    <div class="summary-grid">
      <div class="summary-card"><span>Total recorded</span><strong>${totalAmount}</strong><small>${currencies} · saved in each bill’s original currency</small></div>
      <div class="summary-card"><span>Expenses</span><strong>${trip.expenses.length}</strong><small>${trip.settlements.length} settlements recorded</small></div>
      <div class="summary-card"><span>Participants</span><strong>${activePeople(trip).length}</strong><small>${activePeople(trip).map((person) => escapeHtml(person.name)).join(" · ") || "Add someone to the trip"}</small></div>
    </div>
    <div class="content-grid">
      <section class="panel" aria-label="Trip expenses">
        <div class="panel-heading"><h3>Expenses</h3><span>${trip.expenses.length} total</span></div>
        <ul class="expense-list">${expenseList}</ul>
      </section>
      <section class="panel" aria-label="Trip balances">
        <div class="panel-heading"><h3>Balances</h3><span>paid − share</span></div>
        <ul class="balance-list">${balancesContent}</ul>
        ${settlementRows ? `<ul class="balance-list">${settlementRows}</ul>` : ""}
      </section>
    </div>
    <div class="trip-footer">
      <span>Balances stay separate by currency. No exchange rate is assumed.</span>
      <button class="link-button" type="button" data-action="export-trip">Export trip data</button>
    </div>`;
}

function openDialog(dialog) {
  dialog.showModal();
}

function openNewTripDialog() {
  editingTripId = null;
  ui.tripForm.reset();
  ui.tripError.textContent = "";
  ui.tripForm.querySelector(".dialog-heading h2").textContent = "New trip";
  ui.tripForm.querySelector('[type="submit"]').textContent = "Create trip";
  const peopleField = ui.tripForm.elements.people;
  peopleField.closest("label").hidden = false;
  peopleField.required = true;
  ui.tripForm.elements.startDate.value = new Date().toISOString().slice(0, 10);
  ui.tripForm.elements.endDate.value = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  openDialog(ui.tripDialog);
}

function openEditTripDialog() {
  const trip = activeTrip();
  if (!trip) return;
  editingTripId = trip.id;
  ui.tripForm.reset();
  ui.tripError.textContent = "";
  ui.tripForm.querySelector(".dialog-heading h2").textContent = "Edit trip details";
  ui.tripForm.querySelector('[type="submit"]').textContent = "Save changes";
  const peopleField = ui.tripForm.elements.people;
  peopleField.closest("label").hidden = true;
  peopleField.required = false;
  ui.tripForm.elements.name.value = trip.name;
  ui.tripForm.elements.destination.value = trip.destination;
  ui.tripForm.elements.startDate.value = trip.startDate;
  ui.tripForm.elements.endDate.value = trip.endDate;
  ui.tripForm.elements.currency.value = trip.currency;
  openDialog(ui.tripDialog);
}

function deleteTrip() {
  const trip = activeTrip();
  if (!trip) return;
  const detailCount = trip.expenses.length + trip.settlements.length;
  const details = detailCount ? ` This also deletes ${trip.expenses.length} expense(s) and ${trip.settlements.length} settlement(s).` : "";
  if (!window.confirm(`Delete the trip "${trip.name}"?${details} This cannot be undone.`)) return;
  data.trips = data.trips.filter((entry) => entry.id !== trip.id);
  activeTripId = data.trips[0]?.id ?? null;
  saveLocalData();
  render();
  showToast("Trip deleted from this device. Sync Google Drive to apply the deletion there too.");
}

function addParticipant(trip, name) {
  const normalized = name.trim();
  if (!normalized) return false;
  const existing = trip.people.find((person) => person.name.toLowerCase() === normalized.toLowerCase());
  if (existing) {
    if (existing.active !== false) return false;
    existing.active = true;
    return true;
  }
  trip.people.push({ id: makeId(), name: normalized });
  return true;
}

function renderParticipantChecks(trip, prefix, selectedIds = activePeople(trip).map((person) => person.id), participants = activePeople(trip)) {
  return `<div class="participant-checks">${participants.map((person) => `
    <label class="participant-chip"><input type="checkbox" name="${prefix}" value="${escapeHtml(person.id)}" ${selectedIds.includes(person.id) ? "checked" : ""} />${escapeHtml(person.name)}</label>`).join("")}</div>`;
}

function selectedParticipantIds(prefix) {
  return [...document.querySelectorAll(`input[name="${prefix}"]:checked`)].map((input) => input.value);
}

function buildSplitFields(trip, expense = null) {
  if (!trip) return;
  const method = ui.expenseForm.elements.method.value;
  const currency = ui.expenseForm.elements.currency.value;
  const participants = expensePeople(trip, expense);
  const selectedIds = expense ? Object.keys(expense.shares ?? {}) : activePeople(trip).map((person) => person.id);
  const amountInput = ui.expenseForm.elements.amount;
  amountInput.readOnly = method === "items";
  amountInput.required = method !== "items";
  amountInput.placeholder = method === "items" ? "Calculated from item list" : "0.00";
  amountInput.classList.toggle("is-readonly", method === "items");

  if (method === "equal") {
    ui.splitFields.innerHTML = `<span class="eyebrow">Split between</span>${renderParticipantChecks(trip, "split-person", selectedIds, participants)}`;
  } else if (method === "custom") {
    ui.splitFields.innerHTML = `<span class="eyebrow">Share amounts (${escapeHtml(currency)})</span>${participants.map((person) => `
      <label class="split-person"><span>${escapeHtml(person.name)}</span><input name="custom-${escapeHtml(person.id)}" type="number" inputmode="decimal" min="0" step="${CURRENCY_DIGITS.has(currency) ? "1" : "0.01"}" placeholder="0" value="${expense?.shares?.[person.id] ? centsToInput(expense.shares[person.id], currency) : ""}" /></label>`).join("")}`;
  } else if (method === "weighted") {
    ui.splitFields.innerHTML = `<span class="eyebrow">Share weights (e.g. 2 = twice the share)</span>${participants.map((person) => `
      <label class="split-person"><span>${escapeHtml(person.name)}</span><input name="weight-${escapeHtml(person.id)}" type="number" inputmode="decimal" min="0" step="0.1" value="${expense ? (expense.shares?.[person.id] ?? 0) : 1}" /></label>`).join("")}`;
  } else {
    ui.splitFields.innerHTML = `<span class="eyebrow">Add each item and who shared it</span><div id="item-list"></div>
      <button class="button button-quiet" type="button" data-action="add-item">+ Add item</button>`;
    if (expense?.items?.length) {
      for (const item of expense.items) addItemRow(trip, item, participants);
    } else {
      addItemRow(trip, null, participants);
    }
  }
}

function addItemRow(trip, item = null, participants = activePeople(trip)) {
  const list = document.querySelector("#item-list");
  if (!list) return;
  const itemId = makeId();
  const itemParticipants = item ? Object.keys(item.shares ?? {}) : participants.map((person) => person.id);
  const currency = ui.expenseForm.elements.currency.value;
  const row = document.createElement("div");
  row.className = "item-split";
  row.dataset.itemId = itemId;
  row.innerHTML = `<div class="item-fields">
    <input name="item-name" required maxlength="60" placeholder="Item name" aria-label="Item name" value="${escapeHtml(item?.description ?? "")}" />
    <input name="item-amount" type="number" inputmode="decimal" min="${CURRENCY_DIGITS.has(currency) ? "1" : "0.01"}" step="${CURRENCY_DIGITS.has(currency) ? "1" : "0.01"}" required placeholder="Amount" aria-label="Item amount" value="${item ? centsToInput(item.amountCents, currency) : ""}" />
    <button type="button" data-action="remove-item" aria-label="Remove item">×</button>
  </div>${renderParticipantChecks(trip, `item-${itemId}`, itemParticipants, participants)}`;
  list.append(row);
}

function openExpenseDialog() {
  const trip = activeTrip();
  if (!trip) return;
  editingExpenseId = null;
  ui.expenseForm.reset();
  ui.expenseError.textContent = "";
  ui.expenseForm.querySelector(".dialog-heading h2").textContent = "New expense";
  ui.expenseForm.querySelector('[type="submit"]').textContent = "Save expense";
  ui.expenseForm.elements.date.value = new Date().toISOString().slice(0, 10);
  ui.expenseForm.elements.currency.value = trip.currency;
  ui.expenseForm.elements.paidBy.innerHTML = activePeople(trip).map((person) => `<option value="${escapeHtml(person.id)}">${escapeHtml(person.name)}</option>`).join("");
  buildSplitFields(trip);
  openDialog(ui.expenseDialog);
}

function openEditExpense(expenseId) {
  const trip = activeTrip();
  const expense = trip?.expenses.find((entry) => entry.id === expenseId);
  if (!trip || !expense) {
    showToast("That expense could not be found.");
    return;
  }
  editingExpenseId = expenseId;
  const form = ui.expenseForm;
  form.reset();
  ui.expenseError.textContent = "";
  form.querySelector(".dialog-heading h2").textContent = "Edit expense";
  form.querySelector('[type="submit"]').textContent = "Save changes";
  form.elements.description.value = expense.description;
  form.elements.date.value = expense.date;
  form.elements.amount.value = centsToInput(expense.amountCents, expense.currency);
  form.elements.currency.value = expense.currency;
  form.elements.method.value = expense.method;
  const participants = expensePeople(trip, expense);
  form.elements.paidBy.innerHTML = participants.map((person) =>
    `<option value="${escapeHtml(person.id)}">${escapeHtml(person.name)}</option>`).join("");
  form.elements.paidBy.value = expense.paidBy;
  buildSplitFields(trip, expense);
  openDialog(ui.expenseDialog);
}

function createExpense(event) {
  event.preventDefault();
  const trip = activeTrip();
  if (!trip) return;
  const form = ui.expenseForm;
  const currency = form.elements.currency.value;
  const method = form.elements.method.value;
  const originalExpense = editingExpenseId ? trip.expenses.find((expense) => expense.id === editingExpenseId) : null;
  const participants = expensePeople(trip, originalExpense);
  let amountCents = method === "items" ? 0 : amountToCents(form.elements.amount.value, currency);
  let shares = {};
  let items = [];
  try {
    if (method === "equal") {
      const peopleIds = selectedParticipantIds("split-person");
      if (!peopleIds.length) throw new Error("Select at least one person to split this expense.");
      shares = splitEqual(amountCents, peopleIds);
    } else if (method === "custom") {
      const values = Object.fromEntries(participants.map((person) => [
        person.id,
        amountToCents(form.elements[`custom-${person.id}`].value, currency),
      ]).filter(([, cents]) => cents > 0));
      const sum = Object.values(values).reduce((acc, cents) => acc + cents, 0);
      if (sum !== amountCents) throw new Error(`Custom shares add up to ${formatMoney(sum, currency)}; they must equal the expense total ${formatMoney(amountCents, currency)}.`);
      if (!Object.keys(values).length) throw new Error("Enter a share for at least one person.");
      shares = values;
    } else if (method === "weighted") {
      const weights = Object.fromEntries(participants.map((person) => [
        person.id,
        Number(form.elements[`weight-${person.id}`].value),
      ]));
      shares = makeShares(amountCents, weights);
    } else {
      const rows = [...document.querySelectorAll(".item-split")];
      if (!rows.length) throw new Error("Add at least one item.");
      for (const row of rows) {
        const itemAmount = amountToCents(row.querySelector('[name="item-amount"]').value, currency);
        const participantIds = selectedParticipantIds(`item-${row.dataset.itemId}`);
        if (!itemAmount || !participantIds.length) throw new Error("Each item needs an amount and at least one person.");
        const itemDescription = row.querySelector('[name="item-name"]').value.trim();
        if (!itemDescription) throw new Error("Each item needs a description.");
        const itemShares = splitEqual(itemAmount, participantIds);
        items.push({ description: itemDescription, amountCents: itemAmount, shares: itemShares });
        for (const [personId, cents] of Object.entries(itemShares)) shares[personId] = (shares[personId] ?? 0) + cents;
        amountCents += itemAmount;
      }
      form.elements.amount.value = centsToInput(amountCents, currency);
    }
    if (!amountCents) throw new Error("Enter a valid amount greater than zero.");
    const description = form.elements.description.value.trim();
    if (!description) throw new Error("Add a description for the expense.");
    const methodLabels = { equal: "Equal split", custom: "Custom split", weighted: "Weighted split", items: "Itemized split" };
    const savedExpense = {
      id: originalExpense?.id ?? makeId(),
      description,
      date: form.elements.date.value,
      createdAt: originalExpense?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      amountCents,
      currency,
      paidBy: form.elements.paidBy.value,
      method,
      methodLabel: methodLabels[method],
      shares,
      items,
    };
    if (originalExpense) {
      const index = trip.expenses.findIndex((expense) => expense.id === editingExpenseId);
      trip.expenses[index] = savedExpense;
    } else {
      trip.expenses.push(savedExpense);
    }
    editingExpenseId = null;
    saveLocalData();
    ui.expenseDialog.close();
    render();
    showToast(`${originalExpense ? "Expense updated" : "Expense saved"} on this device. Sync Google Drive to back it up.`);
  } catch (error) {
    ui.expenseError.textContent = error.message;
  }
}

function openSettlementDialog() {
  const trip = activeTrip();
  if (!trip) return;
  editingSettlementId = null;
  const form = ui.settlementForm;
  form.reset();
  ui.settlementError.textContent = "";
  form.querySelector(".dialog-heading h2").textContent = "Record settlement";
  form.querySelector('[type="submit"]').textContent = "Record payment";
  const peopleOptions = trip.people.map((person) => `<option value="${escapeHtml(person.id)}">${escapeHtml(person.name)}</option>`).join("");
  form.elements.from.innerHTML = peopleOptions;
  form.elements.to.innerHTML = peopleOptions;
  form.elements.currency.innerHTML = [...new Set([
    trip.currency,
    ...trip.expenses.map((expense) => expense.currency),
    ...trip.settlements.map((settlement) => settlement.currency),
  ])]
    .map((currency) => `<option value="${escapeHtml(currency)}">${escapeHtml(currency)}</option>`).join("");
  openDialog(ui.settlementDialog);
}

function openEditSettlementDialog(settlementId) {
  const trip = activeTrip();
  const settlement = trip?.settlements.find((entry) => entry.id === settlementId);
  if (!trip || !settlement) {
    showToast("That settlement could not be found.");
    return;
  }
  editingSettlementId = settlementId;
  const form = ui.settlementForm;
  form.reset();
  ui.settlementError.textContent = "";
  form.querySelector(".dialog-heading h2").textContent = "Edit settlement";
  form.querySelector('[type="submit"]').textContent = "Save changes";
  const peopleOptions = trip.people.map((person) => `<option value="${escapeHtml(person.id)}">${escapeHtml(person.name)}</option>`).join("");
  form.elements.from.innerHTML = peopleOptions;
  form.elements.to.innerHTML = peopleOptions;
  form.elements.currency.innerHTML = [...new Set([
    trip.currency,
    ...trip.expenses.map((expense) => expense.currency),
    ...trip.settlements.map((entry) => entry.currency),
  ])].map((currency) => `<option value="${escapeHtml(currency)}">${escapeHtml(currency)}</option>`).join("");
  form.elements.from.value = settlement.from;
  form.elements.to.value = settlement.to;
  form.elements.currency.value = settlement.currency;
  form.elements.amount.value = centsToInput(settlement.amountCents, settlement.currency);
  openDialog(ui.settlementDialog);
}

function createSettlement(event) {
  event.preventDefault();
  const trip = activeTrip();
  if (!trip) return;
  const form = ui.settlementForm;
  const from = form.elements.from.value;
  const to = form.elements.to.value;
  const currency = form.elements.currency.value;
  const amountCents = amountToCents(form.elements.amount.value, currency);
  if (!amountCents) {
    ui.settlementError.textContent = "Enter a valid amount greater than zero.";
    return;
  }
  if (from === to) {
    ui.settlementError.textContent = "Choose two different people.";
    return;
  }
  const baseline = editingSettlementId
    ? { ...trip, settlements: trip.settlements.filter((settlement) => settlement.id !== editingSettlementId) }
    : trip;
  const balances = tripBalances(baseline);
  const fromBalance = balances[from]?.[currency] ?? 0;
  const toBalance = balances[to]?.[currency] ?? 0;
  if (fromBalance >= 0 || toBalance <= 0) {
    ui.settlementError.textContent = "The payer must currently owe money and the recipient must be owed money in this currency.";
    return;
  }
  if (amountCents > Math.min(Math.abs(fromBalance), toBalance)) {
    ui.settlementError.textContent = `The amount is greater than the open balance. Maximum between these people: ${formatMoney(Math.min(Math.abs(fromBalance), toBalance), currency)}.`;
    return;
  }
  const originalSettlement = editingSettlementId
    ? trip.settlements.find((settlement) => settlement.id === editingSettlementId)
    : null;
  const savedSettlement = {
    id: originalSettlement?.id ?? makeId(),
    from,
    to,
    currency,
    amountCents,
    createdAt: originalSettlement?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (originalSettlement) {
    const index = trip.settlements.findIndex((settlement) => settlement.id === editingSettlementId);
    trip.settlements[index] = savedSettlement;
  } else {
    trip.settlements.push(savedSettlement);
  }
  editingSettlementId = null;
  saveLocalData();
  ui.settlementDialog.close();
  render();
  showToast(`${originalSettlement ? "Settlement updated" : "Settlement recorded"}. Sync Google Drive to back it up.`);
}

function deleteSettlement(settlementId) {
  const trip = activeTrip();
  const settlement = trip?.settlements.find((entry) => entry.id === settlementId);
  if (!trip || !settlement) {
    showToast("That settlement could not be found.");
    return;
  }
  if (!window.confirm(`Delete this ${formatMoney(settlement.amountCents, settlement.currency)} settlement? Trip balances will be recalculated.`)) return;
  trip.settlements = trip.settlements.filter((entry) => entry.id !== settlementId);
  saveLocalData();
  render();
  showToast("Settlement deleted and balances recalculated.");
}

function exportTrip() {
  const trip = activeTrip();
  if (!trip) return;
  const blob = new Blob([JSON.stringify(trip, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${trip.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "trip"}-expenses.json`;
  link.click();
  URL.revokeObjectURL(url);
  showToast("Trip data exported. Downloaded copies are outside the app and are not auto-deleted.");
}

function createTrip(event) {
  event.preventDefault();
  const form = ui.tripForm;
  const fields = form.elements;
  const startDate = fields.startDate.value;
  const endDate = fields.endDate.value;
  if (endDate < startDate) {
    ui.tripError.textContent = "The trip end date must be on or after the start date.";
    return;
  }
  const existingTrip = editingTripId ? data.trips.find((trip) => trip.id === editingTripId) : null;
  if (editingTripId && !existingTrip) {
    ui.tripError.textContent = "This trip could not be found. Close this window and try again.";
    return;
  }
  const name = fields.name.value.trim();
  if (!name) {
    ui.tripError.textContent = "Add a name for the trip.";
    return;
  }
  if (existingTrip) {
    existingTrip.name = name;
    existingTrip.destination = fields.destination.value.trim();
    existingTrip.startDate = startDate;
    existingTrip.endDate = endDate;
    existingTrip.currency = fields.currency.value;
    saveLocalData();
    editingTripId = null;
    form.reset();
    ui.tripDialog.close();
    render();
    showToast("Trip details updated. Sync Google Drive to back up your changes.");
    return;
  }
  const trip = {
    id: makeId(),
    name,
    destination: fields.destination.value.trim(),
    startDate,
    endDate,
    currency: fields.currency.value,
    emoji: "✈",
    people: [],
    expenses: [],
    settlements: [],
  };
  const names = fields.people.value.split(",").map((name) => name.trim()).filter(Boolean);
  for (const name of names) addParticipant(trip, name);
  if (!trip.people.length) {
    ui.tripError.textContent = "Add at least one person to the trip.";
    return;
  }
  data.trips.push(trip);
  activeTripId = trip.id;
  saveLocalData();
  form.reset();
  ui.tripDialog.close();
  render();
  showToast("Trip created. Sync Google Drive to back it up.");
}

function addPerson() {
  const trip = activeTrip();
  if (!trip) return;
  ui.peopleForm.reset();
  ui.peopleError.textContent = "";
  renderPeopleList(trip);
  openDialog(ui.peopleDialog);
}

function renderPeopleList(trip) {
  ui.peopleList.innerHTML = trip.people.map((person) => {
    const isActive = person.active !== false;
    const label = isActive ? "Remove" : "Restore";
    const action = isActive ? "remove-person" : "restore-person";
    return `<div class="people-row">
      <span class="people-name"><input name="person-name-${escapeHtml(person.id)}" value="${escapeHtml(person.name)}" aria-label="Name for ${escapeHtml(person.name)}" /><small>${isActive ? "Included in new expenses" : "Removed from new expenses"}</small></span>
      <span class="people-actions">
        <button class="row-action" type="button" data-action="rename-person" data-person-id="${escapeHtml(person.id)}">Save name</button>
        <button class="row-action ${isActive ? "row-action-danger" : ""}" type="button" data-action="${action}" data-person-id="${escapeHtml(person.id)}">${label}</button>
      </span>
    </div>`;
  }).join("");
}

function renameParticipant(personId) {
  const trip = activeTrip();
  const person = trip?.people.find((entry) => entry.id === personId);
  const input = ui.peopleList.querySelector(`[name="person-name-${CSS.escape(personId)}"]`);
  const name = input?.value.trim() ?? "";
  if (!trip || !person || !name) {
    ui.peopleError.textContent = "Enter a name for the participant.";
    return;
  }
  if (trip.people.some((entry) => entry.id !== personId && entry.name.toLowerCase() === name.toLowerCase())) {
    ui.peopleError.textContent = "Another participant already has that name.";
    return;
  }
  person.name = name;
  saveLocalData();
  render();
  renderPeopleList(trip);
  ui.peopleError.textContent = "";
  showToast("Participant name updated.");
}

function participantIsReferenced(trip, personId) {
  return trip.expenses.some((expense) =>
    expense.paidBy === personId ||
    Object.hasOwn(expense.shares ?? {}, personId) ||
    (expense.items ?? []).some((item) => Object.hasOwn(item.shares ?? {}, personId))) ||
    trip.settlements.some((settlement) => settlement.from === personId || settlement.to === personId);
}

function changeParticipantStatus(personId, active) {
  const trip = activeTrip();
  const person = trip?.people.find((entry) => entry.id === personId);
  if (!trip || !person) {
    showToast("That participant could not be found.");
    return;
  }
  if (active && person.active !== false) return;
  if (!active && person.active === false) return;
  if (!active && activePeople(trip).length <= 1) {
    showToast("A trip must have at least one active participant.");
    return;
  }
  if (!active && !participantIsReferenced(trip, personId)) {
    trip.people = trip.people.filter((entry) => entry.id !== personId);
    showToast(`${person.name} was removed from the trip.`);
  } else {
    person.active = active;
    showToast(active
      ? `${person.name} was restored for new expenses.`
      : `${person.name} was removed from new expenses. Their history and balances are preserved.`);
  }
  saveLocalData();
  render();
  renderPeopleList(trip);
}

function createParticipant(event) {
  event.preventDefault();
  const trip = activeTrip();
  const name = ui.peopleForm.elements.name.value.trim();
  if (!trip || !name) {
    ui.peopleError.textContent = "Enter a name for the person.";
    return;
  }
  if (!addParticipant(trip, name)) {
    ui.peopleError.textContent = "That person is already active in this trip.";
    return;
  }
  saveLocalData();
  ui.peopleForm.reset();
  ui.peopleError.textContent = "";
  render();
  renderPeopleList(trip);
  showToast(`${name} was added to the trip.`);
}

function deleteExpense(expenseId) {
  const trip = activeTrip();
  const expense = trip?.expenses.find((entry) => entry.id === expenseId);
  if (!trip || !expense) {
    showToast("That expense could not be found.");
    return;
  }
  if (!window.confirm(`Delete "${expense.description}" (${formatMoney(expense.amountCents, expense.currency)})? This will recalculate trip balances.`)) return;
  trip.expenses = trip.expenses.filter((entry) => entry.id !== expenseId);
  saveLocalData();
  render();
  showToast("Expense deleted and trip balances recalculated.");
}

function getGoogleClientId() {
  return window.APP_CONFIG?.googleClientId?.trim() || "";
}

function connectGoogleDrive() {
  const clientId = getGoogleClientId();
  if (!clientId) {
    showToast("Set googleClientId in config.js first. See README.md for Google OAuth setup.");
    return;
  }
  if (!window.google?.accounts?.oauth2) {
    showToast("Google sign-in is still loading. Check your connection and try again.");
    return;
  }
  const tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: GOOGLE_SCOPE,
    callback: async (tokenResponse) => {
      if (tokenResponse.error) {
        console.error("Google authorization failed.", tokenResponse);
        updateSyncStatus("Google sign-in failed", "error");
        showToast(`Google sign-in failed: ${tokenResponse.error}`);
        return;
      }
      accessToken = tokenResponse.access_token;
      tokenExpiresAt = Date.now() + Number(tokenResponse.expires_in || 3600) * 1000;
      ui.connectButton.disabled = true;
      updateSyncStatus("Syncing with Google Drive…");
      try {
        await syncDrive();
        render();
      } catch (error) {
        console.error("Google Drive sync failed.", error);
        if (error.message.includes("changed on another device") && window.confirm("A newer copy exists in Google Drive. Discard the unsynced changes on this device and load the Google Drive copy?")) {
          try {
            dirty = false;
            await syncDrive();
            render();
            return;
          } catch (reloadError) {
            console.error("Could not load the latest Google Drive copy.", reloadError);
            error = reloadError;
          }
        }
        updateSyncStatus("Google Drive sync failed", "error");
        showToast(error.message);
      } finally {
        ui.connectButton.disabled = false;
      }
    },
    error_callback: (error) => {
      console.error("Google authorization popup failed.", error);
      updateSyncStatus("Google sign-in failed", "error");
      showToast(error.message || "The sign-in window could not be opened.");
    },
  });
  tokenClient.requestAccessToken({ prompt: accessToken ? "" : "consent" });
}

async function driveRequest(path, options = {}) {
  if (!accessToken || Date.now() >= tokenExpiresAt - 30_000) throw new Error("Google Drive access expired. Reconnect to sync.");
  const response = await fetch(`https://www.googleapis.com/drive/v3${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${accessToken}`, ...(options.headers ?? {}) },
  });
  if (!response.ok) {
    let message = `Google Drive request failed (${response.status}).`;
    try {
      const error = await response.json();
      message = error.error?.message || message;
    } catch (parseError) {
      console.warn("Could not read Google Drive error details.", parseError);
    }
    if (response.status === 401) accessToken = null;
    throw new Error(message);
  }
  return response;
}

async function findDriveFile() {
  const query = new URLSearchParams({
    spaces: "appDataFolder",
    q: `name='${DRIVE_FILE_NAME}' and trashed=false`,
    pageSize: "1",
    fields: "files(id,name,modifiedTime)",
  });
  const response = await driveRequest(`/files?${query.toString()}`);
  const result = await response.json();
  return result.files?.[0] ?? null;
}

async function readDriveData(fileId) {
  const response = await driveRequest(`/files/${encodeURIComponent(fileId)}?alt=media`);
  const parsed = await response.json();
  if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.trips)) throw new Error("The Google Drive data file has an unsupported format.");
  return { data: parsed, etag: response.headers.get("ETag") };
}

async function writeDriveData(existingFile, payload, etag) {
  const body = JSON.stringify(payload);
  if (existingFile) {
    const response = await driveRequest(`/upload/drive/v3/files/${encodeURIComponent(existingFile.id)}?uploadType=media`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...(etag ? { "If-Match": etag } : {}) },
      body,
    });
    return response.json();
  }
  const metadataResponse = await driveRequest("/files?fields=id,name,modifiedTime", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: DRIVE_FILE_NAME, parents: ["appDataFolder"], mimeType: "application/json" }),
  });
  const created = await metadataResponse.json();
  try {
    const uploadResponse = await driveRequest(`/upload/drive/v3/files/${encodeURIComponent(created.id)}?uploadType=media`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const uploaded = await uploadResponse.json();
    return { ...created, ...uploaded };
  } catch (error) {
    console.error("Drive file created but first data upload failed.", error);
    throw new Error(`Google Drive created the app data file but could not save its contents: ${error.message}`);
  }
}

async function syncDrive() {
  const remoteFile = await findDriveFile();
  if (!remoteFile) {
    if (driveBaselineModifiedTime && !dirty) {
      throw new Error("The Drive data file is missing. Local data was kept; export it before continuing.");
    }
    await writeDriveData(null, data);
    driveFile = await findDriveFile();
    driveBaselineModifiedTime = driveFile?.modifiedTime ?? null;
    dirty = false;
    saveLocalData(false);
    updateSyncStatus("Synced with Google Drive");
    showToast("Your trip data is now backed up to your Google account.");
    return;
  }
  if (dirty) {
    if (!driveBaselineModifiedTime && !window.confirm("Google Drive already contains trip data. Replace it with this device's unsynced data? Trips only in Google Drive may be permanently removed. Cancel keeps both copies unchanged.")) {
      throw new Error("The existing Google Drive data was kept. Your local changes are still saved on this device.");
    }
    if (driveBaselineModifiedTime && remoteFile.modifiedTime !== driveBaselineModifiedTime) {
      throw new Error("This data changed on another device. Your local changes are safe on this device; reconnect and reload the latest Drive data before editing further.");
    }
    let etag = null;
    if (driveBaselineModifiedTime) {
      const latest = await readDriveData(remoteFile.id);
      etag = latest.etag;
    }
    await writeDriveData(remoteFile, data, etag);
    driveFile = await findDriveFile();
    driveBaselineModifiedTime = driveFile?.modifiedTime ?? null;
    dirty = false;
    saveLocalData(false);
    updateSyncStatus("Synced with Google Drive");
    showToast("Changes synced to Google Drive.");
    return;
  }
  const latest = await readDriveData(remoteFile.id);
  data = latest.data;
  activeTripId = data.activeTripId ?? data.trips[0]?.id ?? null;
  driveFile = remoteFile;
  driveBaselineModifiedTime = remoteFile.modifiedTime;
  saveLocalData(false);
  updateSyncStatus("Synced with Google Drive");
  showToast("Latest trip data loaded from Google Drive.");
}

function handleClick(event) {
  const closeButton = event.target.closest("[data-close]");
  if (closeButton) {
    document.querySelector(`#${closeButton.dataset.close}`)?.close();
    return;
  }
  const tripButton = event.target.closest("[data-trip-id]");
  if (tripButton) {
    activeTripId = tripButton.dataset.tripId;
    saveLocalData();
    render();
    return;
  }
  const actionButton = event.target.closest("[data-action]");
  if (!actionButton) return;
  switch (actionButton.dataset.action) {
    case "new-trip": openNewTripDialog(); break;
    case "edit-trip": openEditTripDialog(); break;
    case "delete-trip": deleteTrip(); break;
    case "add-expense": openExpenseDialog(); break;
    case "add-settlement": openSettlementDialog(); break;
    case "add-person": addPerson(); break;
    case "rename-person": renameParticipant(actionButton.dataset.personId); break;
    case "edit-expense": openEditExpense(actionButton.dataset.expenseId); break;
    case "delete-expense": deleteExpense(actionButton.dataset.expenseId); break;
    case "edit-settlement": openEditSettlementDialog(actionButton.dataset.settlementId); break;
    case "delete-settlement": deleteSettlement(actionButton.dataset.settlementId); break;
    case "remove-person": changeParticipantStatus(actionButton.dataset.personId, false); break;
    case "restore-person": changeParticipantStatus(actionButton.dataset.personId, true); break;
    case "export-trip": exportTrip(); break;
    case "add-item": addItemRow(activeTrip()); break;
    case "remove-item": actionButton.closest(".item-split")?.remove(); break;
  }
}

function handleInput(event) {
  if (!event.target.matches('select[name="method"]')) return;
  const trip = activeTrip();
  if (!trip) return;
  const expense = editingExpenseId ? trip.expenses.find((entry) => entry.id === editingExpenseId) : null;
  buildSplitFields(trip, expense);
}

function setupApp() {
  pruneExpiredTrips();
  render();
  updateSyncStatus();
  document.querySelector("#new-trip").addEventListener("click", openNewTripDialog);
  ui.tripForm.addEventListener("submit", createTrip);
  ui.expenseForm.addEventListener("submit", createExpense);
  ui.settlementForm.addEventListener("submit", createSettlement);
  ui.peopleForm.addEventListener("submit", createParticipant);
  ui.connectButton.addEventListener("click", connectGoogleDrive);
  document.addEventListener("click", handleClick);
  ui.expenseForm.addEventListener("change", handleInput);
  ui.tripForm.elements.startDate.value = new Date().toISOString().slice(0, 10);
  ui.tripForm.elements.endDate.value = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register("./sw.js").catch((error) => console.warn("Offline cache could not be enabled.", error));
  }
}

setupApp();
