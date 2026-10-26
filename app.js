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
  expenseDialog: document.querySelector("#expense-dialog"),
  expenseForm: document.querySelector("#expense-form"),
  splitFields: document.querySelector("#split-fields"),
  expenseError: document.querySelector("#expense-error"),
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
      return `<li class="expense-row">
        <span class="expense-icon" aria-hidden="true">${expense.method === "items" ? "▤" : "↗"}</span>
        <span class="expense-description"><strong>${escapeHtml(expense.description)}</strong><small>Paid by ${escapeHtml(payer)} · ${splitCount} ${splitCount === 1 ? "person" : "people"} · ${escapeHtml(expense.methodLabel)}${expense.items?.length ? ` · ${expense.items.length} items` : ""}</small></span>
        <span class="expense-amount"><strong>${formatMoney(expense.amountCents, expense.currency)}</strong><small>${formatDate(expense.date)}</small></span>
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
    return `<li class="balance-row"><span class="balance-name"><span class="avatar">${escapeHtml(person.name.trim().slice(0, 1).toUpperCase())}</span>${escapeHtml(person.name)}</span><span class="balance-amount">${amounts || `<span class="zero">${formatMoney(0, trip.currency)}</span>`}</span></li>`;
  }).join("");
  const settlementRows = trip.settlements.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 4).map((settlement) => {
    const from = trip.people.find((person) => person.id === settlement.from)?.name ?? "Someone";
    const to = trip.people.find((person) => person.id === settlement.to)?.name ?? "someone";
    return `<li class="settlement-row">${escapeHtml(from)} paid ${escapeHtml(to)} ${formatMoney(settlement.amountCents, settlement.currency)}</li>`;
  }).join("");
  const formattedDates = `${formatDate(trip.startDate)} – ${formatDate(trip.endDate)}`;
  const participantsLabel = `${trip.people.length} ${trip.people.length === 1 ? "person" : "people"}`;
  const currencies = Object.keys(totals).length ? `${Object.keys(totals).length} ${Object.keys(totals).length === 1 ? "currency" : "currencies"}` : "No bills yet";

  ui.tripContent.innerHTML = `
    <div class="trip-header">
      <div>
        <p class="eyebrow">${escapeHtml(trip.destination || "Your trip")}</p>
        <h2>${escapeHtml(trip.name)}</h2>
        <div class="trip-meta"><span>◷ ${formattedDates}</span><span>♙ ${participantsLabel}</span><span>◎ ${escapeHtml(trip.currency)} home currency</span></div>
      </div>
      <div class="trip-actions">
        <button class="button button-quiet" type="button" data-action="add-person">+ Person</button>
        <button class="button button-quiet" type="button" data-action="add-settlement">Record payment</button>
        <button class="button button-primary" type="button" data-action="add-expense">+ Expense</button>
      </div>
    </div>
    <div class="summary-grid">
      <div class="summary-card"><span>Total recorded</span><strong>${totalAmount}</strong><small>${currencies} · saved in each bill’s original currency</small></div>
      <div class="summary-card"><span>Expenses</span><strong>${trip.expenses.length}</strong><small>${trip.settlements.length} settlements recorded</small></div>
      <div class="summary-card"><span>Participants</span><strong>${trip.people.length}</strong><small>${trip.people.map((person) => escapeHtml(person.name)).join(" · ")}</small></div>
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

function addParticipant(trip, name) {
  const normalized = name.trim();
  if (!normalized || trip.people.some((person) => person.name.toLowerCase() === normalized.toLowerCase())) return false;
  trip.people.push({ id: makeId(), name: normalized });
  return true;
}

function renderParticipantChecks(trip, prefix, selectedIds = trip.people.map((person) => person.id)) {
  return `<div class="participant-checks">${trip.people.map((person) => `
    <label class="participant-chip"><input type="checkbox" name="${prefix}" value="${escapeHtml(person.id)}" ${selectedIds.includes(person.id) ? "checked" : ""} />${escapeHtml(person.name)}</label>`).join("")}</div>`;
}

function selectedParticipantIds(prefix) {
  return [...document.querySelectorAll(`input[name="${prefix}"]:checked`)].map((input) => input.value);
}

function buildSplitFields() {
  const trip = activeTrip();
  if (!trip) return;
  const method = ui.expenseForm.elements.method.value;
  const currency = ui.expenseForm.elements.currency.value;
  const amountInput = ui.expenseForm.elements.amount;
  amountInput.readOnly = method === "items";
  amountInput.required = method !== "items";
  amountInput.placeholder = method === "items" ? "Calculated from item list" : "0.00";
  amountInput.classList.toggle("is-readonly", method === "items");

  if (method === "equal") {
    ui.splitFields.innerHTML = `<span class="eyebrow">Split between</span>${renderParticipantChecks(trip, "split-person")}`;
  } else if (method === "custom") {
    ui.splitFields.innerHTML = `<span class="eyebrow">Share amounts (${escapeHtml(currency)})</span>${trip.people.map((person) => `
      <label class="split-person"><span>${escapeHtml(person.name)}</span><input name="custom-${escapeHtml(person.id)}" type="number" inputmode="decimal" min="0" step="${CURRENCY_DIGITS.has(currency) ? "1" : "0.01"}" placeholder="0" /></label>`).join("")}`;
  } else if (method === "weighted") {
    ui.splitFields.innerHTML = `<span class="eyebrow">Share weights (e.g. 2 = twice the share)</span>${trip.people.map((person) => `
      <label class="split-person"><span>${escapeHtml(person.name)}</span><input name="weight-${escapeHtml(person.id)}" type="number" inputmode="decimal" min="0" step="0.1" value="1" /></label>`).join("")}`;
  } else {
    ui.splitFields.innerHTML = `<span class="eyebrow">Add each item and who shared it</span><div id="item-list"></div>
      <button class="button button-quiet" type="button" data-action="add-item">+ Add item</button>`;
    addItemRow(trip);
  }
}

function addItemRow(trip) {
  const list = document.querySelector("#item-list");
  if (!list) return;
  const itemId = makeId();
  const row = document.createElement("div");
  row.className = "item-split";
  row.dataset.itemId = itemId;
  row.innerHTML = `<div class="item-fields">
    <input name="item-name" required maxlength="60" placeholder="Item name" aria-label="Item name" />
    <input name="item-amount" type="number" inputmode="decimal" min="${CURRENCY_DIGITS.has(ui.expenseForm.elements.currency.value) ? "1" : "0.01"}" step="${CURRENCY_DIGITS.has(ui.expenseForm.elements.currency.value) ? "1" : "0.01"}" required placeholder="Amount" aria-label="Item amount" />
    <button type="button" data-action="remove-item" aria-label="Remove item">×</button>
  </div>${renderParticipantChecks(trip, `item-${itemId}`)}`;
  list.append(row);
}

function openExpenseDialog() {
  const trip = activeTrip();
  if (!trip) return;
  ui.expenseForm.reset();
  ui.expenseError.textContent = "";
  ui.expenseForm.elements.currency.value = trip.currency;
  ui.expenseForm.elements.paidBy.innerHTML = trip.people.map((person) => `<option value="${escapeHtml(person.id)}">${escapeHtml(person.name)}</option>`).join("");
  buildSplitFields();
  openDialog(ui.expenseDialog);
}

function createExpense(event) {
  event.preventDefault();
  const trip = activeTrip();
  if (!trip) return;
  const form = ui.expenseForm;
  const currency = form.elements.currency.value;
  const method = form.elements.method.value;
  let amountCents = amountToCents(form.elements.amount.value, currency);
  let shares = {};
  let items = [];
  try {
    if (method === "equal") {
      const peopleIds = selectedParticipantIds("split-person");
      if (!peopleIds.length) throw new Error("Select at least one person to split this expense.");
      shares = splitEqual(amountCents, peopleIds);
    } else if (method === "custom") {
      const values = Object.fromEntries(trip.people.map((person) => [
        person.id,
        amountToCents(form.elements[`custom-${person.id}`].value, currency),
      ]).filter(([, cents]) => cents > 0));
      const sum = Object.values(values).reduce((acc, cents) => acc + cents, 0);
      if (sum !== amountCents) throw new Error(`Custom shares add up to ${formatMoney(sum, currency)}; they must equal the expense total ${formatMoney(amountCents, currency)}.`);
      if (!Object.keys(values).length) throw new Error("Enter a share for at least one person.");
      shares = values;
    } else if (method === "weighted") {
      const weights = Object.fromEntries(trip.people.map((person) => [
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
        const itemShares = splitEqual(itemAmount, participantIds);
        items.push({ description: row.querySelector('[name="item-name"]').value.trim(), amountCents: itemAmount, shares: itemShares });
        for (const [personId, cents] of Object.entries(itemShares)) shares[personId] = (shares[personId] ?? 0) + cents;
        amountCents += itemAmount;
      }
      form.elements.amount.value = centsToInput(amountCents, currency);
    }
    if (!amountCents) throw new Error("Enter a valid amount greater than zero.");
    const description = form.elements.description.value.trim();
    if (!description) throw new Error("Add a description for the expense.");
    const methodLabels = { equal: "Equal split", custom: "Custom split", weighted: "Weighted split", items: "Itemized split" };
    trip.expenses.push({
      id: makeId(),
      description,
      date: new Date().toISOString().slice(0, 10),
      createdAt: new Date().toISOString(),
      amountCents,
      currency,
      paidBy: form.elements.paidBy.value,
      method,
      methodLabel: methodLabels[method],
      shares,
      items,
    });
    saveLocalData();
    ui.expenseDialog.close();
    render();
    showToast("Expense saved on this device. Sync Google Drive to back it up.");
  } catch (error) {
    ui.expenseError.textContent = error.message;
  }
}

function openSettlementDialog() {
  const trip = activeTrip();
  if (!trip) return;
  const form = ui.settlementForm;
  form.reset();
  ui.settlementError.textContent = "";
  const peopleOptions = trip.people.map((person) => `<option value="${escapeHtml(person.id)}">${escapeHtml(person.name)}</option>`).join("");
  form.elements.from.innerHTML = peopleOptions;
  form.elements.to.innerHTML = peopleOptions;
  form.elements.currency.innerHTML = [...new Set([trip.currency, ...trip.expenses.map((expense) => expense.currency)])]
    .map((currency) => `<option value="${escapeHtml(currency)}">${escapeHtml(currency)}</option>`).join("");
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
  const balances = tripBalances(trip);
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
  trip.settlements.push({ id: makeId(), from, to, currency, amountCents, createdAt: new Date().toISOString() });
  saveLocalData();
  ui.settlementDialog.close();
  render();
  showToast("Settlement recorded. Sync Google Drive to back it up.");
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
    showToast("The trip end date must be on or after the start date.");
    return;
  }
  const trip = {
    id: makeId(),
    name: fields.name.value.trim(),
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
    showToast("Add at least one person to the trip.");
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
  const name = window.prompt("Name of the person to add:");
  if (name === null) return;
  if (!name.trim()) {
    showToast("Enter a name for the person.");
    return;
  }
  if (!addParticipant(trip, name)) {
    showToast("That name is empty or already in this trip.");
    return;
  }
  saveLocalData();
  render();
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
    case "new-trip": openDialog(ui.tripDialog); break;
    case "add-expense": openExpenseDialog(); break;
    case "add-settlement": openSettlementDialog(); break;
    case "add-person": addPerson(); break;
    case "export-trip": exportTrip(); break;
    case "add-item": addItemRow(activeTrip()); break;
    case "remove-item": actionButton.closest(".item-split")?.remove(); break;
  }
}

function handleInput(event) {
  if (event.target.matches('select[name="method"], select[name="currency"]')) buildSplitFields();
}

function setupApp() {
  pruneExpiredTrips();
  render();
  updateSyncStatus();
  document.querySelector("#new-trip").addEventListener("click", () => openDialog(ui.tripDialog));
  ui.tripForm.addEventListener("submit", createTrip);
  ui.expenseForm.addEventListener("submit", createExpense);
  ui.settlementForm.addEventListener("submit", createSettlement);
  ui.connectButton.addEventListener("click", connectGoogleDrive);
  document.addEventListener("click", handleClick);
  ui.expenseForm.addEventListener("change", handleInput);
  ui.expenseForm.addEventListener("input", (event) => {
    if (event.target.name === "currency") buildSplitFields();
  });
  ui.tripForm.elements.startDate.value = new Date().toISOString().slice(0, 10);
  ui.tripForm.elements.endDate.value = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register("./sw.js").catch((error) => console.warn("Offline cache could not be enabled.", error));
  }
}

setupApp();
