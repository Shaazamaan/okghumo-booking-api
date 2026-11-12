"use strict";

const { randomUUID } = require("crypto");

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function requireString(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, `${name} is required`);
  return value.trim();
}

function requireInt(value, name, min, max = Infinity) {
  if (!Number.isInteger(value) || value < min || value > max) {
    const range = max === Infinity ? `${min} or more` : `${min} to ${max}`;
    throw new HttpError(400, `${name} must be a whole number, ${range}`);
  }
  return value;
}

// In-memory store. The same rules would sit in front of a real database,
// where the seat check becomes a single conditional UPDATE in one transaction.
class BookingStore {
  constructor(now = () => new Date()) {
    this.now = now;
    this.experiences = new Map();
    this.slots = new Map();
    this.bookings = new Map();
  }

  createExperience(input = {}) {
    const experience = {
      id: randomUUID(),
      operatorId: requireString(input.operatorId, "operatorId"),
      title: requireString(input.title, "title"),
      location: requireString(input.location, "location"),
      pricePaise: requireInt(input.pricePaise, "pricePaise", 0),
      durationMin: requireInt(input.durationMin, "durationMin", 1),
    };
    this.experiences.set(experience.id, experience);
    return experience;
  }

  listExperiences(operatorId) {
    return [...this.experiences.values()].filter((e) => !operatorId || e.operatorId === operatorId);
  }

  createSlot(experienceId, input = {}) {
    if (!this.experiences.has(experienceId)) throw new HttpError(404, "experience not found");
    const startsAt = new Date(input.startsAt);
    if (typeof input.startsAt !== "string" || Number.isNaN(startsAt.getTime())) {
      throw new HttpError(400, "startsAt must be an ISO date-time, for example 2026-12-20T10:00:00+05:30");
    }
    if (startsAt <= this.now()) throw new HttpError(400, "startsAt must be in the future");
    const capacity = requireInt(input.capacity, "capacity", 1);
    // Optional: operators who deliberately overbook (expecting no-shows) can set a margin.
    const overbookBy = input.overbookBy === undefined ? 0 : requireInt(input.overbookBy, "overbookBy", 0, capacity);
    const slot = {
      id: randomUUID(),
      experienceId,
      startsAt: startsAt.toISOString(),
      capacity,
      overbookBy,
      booked: 0,
    };
    this.slots.set(slot.id, slot);
    return this.slotView(slot);
  }

  listSlots(experienceId) {
    if (!this.experiences.has(experienceId)) throw new HttpError(404, "experience not found");
    return [...this.slots.values()]
      .filter((s) => s.experienceId === experienceId && new Date(s.startsAt) > this.now())
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
      .map((s) => this.slotView(s));
  }

  book(slotId, input = {}) {
    const slot = this.slots.get(slotId);
    if (!slot) throw new HttpError(404, "slot not found");
    if (new Date(slot.startsAt) <= this.now()) throw new HttpError(409, "this slot has already started");

    // Validate everything first, so a bad request never reserves seats.
    const booking = {
      id: randomUUID(),
      slotId,
      customerName: requireString(input.customerName, "customerName"),
      phone: requireString(input.phone, "phone"),
      partySize: requireInt(input.partySize, "partySize", 1),
      status: "confirmed",
      createdAt: this.now().toISOString(),
    };

    // Check and reserve in one synchronous step, so two requests cannot both take the last seat.
    const limit = slot.capacity + slot.overbookBy;
    if (slot.booked + booking.partySize > limit) {
      const left = Math.max(0, limit - slot.booked);
      throw new HttpError(409, `only ${left} seat${left === 1 ? "" : "s"} left for this slot`);
    }
    slot.booked += booking.partySize;
    this.bookings.set(booking.id, booking);
    return booking;
  }

  listBookings(slotId) {
    if (!this.slots.has(slotId)) throw new HttpError(404, "slot not found");
    return [...this.bookings.values()].filter((b) => b.slotId === slotId);
  }

  cancel(bookingId) {
    const booking = this.bookings.get(bookingId);
    if (!booking) throw new HttpError(404, "booking not found");
    if (booking.status === "cancelled") return booking;
    booking.status = "cancelled";
    this.slots.get(booking.slotId).booked -= booking.partySize;
    return booking;
  }

  slotView(slot) {
    const limit = slot.capacity + slot.overbookBy;
    return { ...slot, seatsLeft: Math.max(0, limit - slot.booked) };
  }
}

module.exports = { BookingStore, HttpError };
