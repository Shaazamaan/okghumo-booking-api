"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { BookingStore } = require("../src/store");
const { createServer } = require("../src/server");

const FUTURE = "2099-12-20T10:00:00+05:30";

async function start(store) {
  const server = createServer(store);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  return { call, close: () => new Promise((r) => server.close(r)) };
}

const EXP = { operatorId: "op_1", title: "Backwater sunset cruise", location: "Alappuzha", pricePaise: 150000, durationMin: 120 };

test("operator creates an experience, a slot, and books it", async () => {
  const api = await start(new BookingStore());
  try {
    const exp = await api.call("POST", "/experiences", EXP);
    assert.equal(exp.status, 201);
    const slot = await api.call("POST", `/experiences/${exp.body.id}/slots`, { startsAt: FUTURE, capacity: 10 });
    assert.equal(slot.status, 201);
    assert.equal(slot.body.seatsLeft, 10);
    const booking = await api.call("POST", `/slots/${slot.body.id}/bookings`, { customerName: "Asha", phone: "9800000000", partySize: 4 });
    assert.equal(booking.status, 201);
    assert.equal(booking.body.status, "confirmed");
    const slots = await api.call("GET", `/experiences/${exp.body.id}/slots`);
    assert.equal(slots.body[0].seatsLeft, 6);
  } finally {
    await api.close();
  }
});

test("overbooking is refused once capacity is reached", async () => {
  const api = await start(new BookingStore());
  try {
    const exp = await api.call("POST", "/experiences", EXP);
    const slot = await api.call("POST", `/experiences/${exp.body.id}/slots`, { startsAt: FUTURE, capacity: 5 });
    const ok = await api.call("POST", `/slots/${slot.body.id}/bookings`, { customerName: "A", phone: "1", partySize: 4 });
    assert.equal(ok.status, 201);
    const over = await api.call("POST", `/slots/${slot.body.id}/bookings`, { customerName: "B", phone: "2", partySize: 2 });
    assert.equal(over.status, 409);
    assert.match(over.body.error, /only 1 seat left/);
  } finally {
    await api.close();
  }
});

test("only one of two simultaneous requests gets the last seat", () => {
  const store = new BookingStore();
  const exp = store.createExperience(EXP);
  const slot = store.createSlot(exp.id, { startsAt: FUTURE, capacity: 1 });
  const attempts = [1, 2].map((n) => {
    try {
      store.book(slot.id, { customerName: `G${n}`, phone: String(n), partySize: 1 });
      return "ok";
    } catch (e) {
      return e.status;
    }
  });
  assert.deepEqual(attempts.sort(), [409, "ok"]);
  assert.equal(store.listSlots(exp.id)[0].seatsLeft, 0);
});

test("cancelling a booking releases its seats", () => {
  const store = new BookingStore();
  const exp = store.createExperience(EXP);
  const slot = store.createSlot(exp.id, { startsAt: FUTURE, capacity: 3 });
  const b = store.book(slot.id, { customerName: "A", phone: "1", partySize: 3 });
  assert.equal(store.listSlots(exp.id)[0].seatsLeft, 0);
  store.cancel(b.id);
  store.cancel(b.id); // cancelling twice must not free extra seats
  assert.equal(store.listSlots(exp.id)[0].seatsLeft, 3);
});

test("optional overbooking margin is respected and nothing beyond it", () => {
  const store = new BookingStore();
  const exp = store.createExperience(EXP);
  const slot = store.createSlot(exp.id, { startsAt: FUTURE, capacity: 4, overbookBy: 1 });
  store.book(slot.id, { customerName: "A", phone: "1", partySize: 5 });
  assert.throws(() => store.book(slot.id, { customerName: "B", phone: "2", partySize: 1 }), { status: 409 });
});

test("past slots and invalid input are rejected", async () => {
  const api = await start(new BookingStore());
  try {
    const exp = await api.call("POST", "/experiences", EXP);
    const past = await api.call("POST", `/experiences/${exp.body.id}/slots`, { startsAt: "2020-01-01T10:00:00Z", capacity: 5 });
    assert.equal(past.status, 400);
    const bad = await api.call("POST", `/experiences/${exp.body.id}/slots`, { startsAt: FUTURE, capacity: 0 });
    assert.equal(bad.status, 400);
    const slot = await api.call("POST", `/experiences/${exp.body.id}/slots`, { startsAt: FUTURE, capacity: 5 });
    const noName = await api.call("POST", `/slots/${slot.body.id}/bookings`, { phone: "1", partySize: 1 });
    assert.equal(noName.status, 400);
    const zero = await api.call("POST", `/slots/${slot.body.id}/bookings`, { customerName: "A", phone: "1", partySize: 0 });
    assert.equal(zero.status, 400);
    const missing = await api.call("POST", "/slots/nope/bookings", { customerName: "A", phone: "1", partySize: 1 });
    assert.equal(missing.status, 404);
  } finally {
    await api.close();
  }
});
