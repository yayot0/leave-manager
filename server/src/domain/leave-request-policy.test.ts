import { describe, expect, it } from "vitest";
import {
  canDecide,
  canView,
  hasActiveManager,
  type Actor,
  type Requester,
  type Role,
} from "./leave-request-policy.js";

function actor(id: string, role: Role, isActive = true): Actor {
  return { id, role, isActive };
}

function requester(id: string, manager: { id: string; isActive: boolean } | null): Requester {
  return {
    id,
    managerId: manager?.id ?? null,
    manager: manager ? { isActive: manager.isActive } : null,
  };
}

const boss = actor("boss", "MANAGER");
const otherBoss = actor("other-boss", "MANAGER");
const hr = actor("hr", "HR");
const peer = actor("peer", "EMPLOYEE");

/** Employee with an active direct manager ("boss"). */
const withActiveBoss = requester("emp", { id: "boss", isActive: true });
/** Employee whose manager is inactive. */
const withInactiveBoss = requester("emp", { id: "boss", isActive: false });
/** Employee without a manager (e.g. the director). */
const withoutBoss = requester("emp", null);

describe("hasActiveManager", () => {
  it("true when managerId is set and the manager is active", () => {
    expect(hasActiveManager(withActiveBoss)).toBe(true);
  });

  it("false when the manager is inactive", () => {
    expect(hasActiveManager(withInactiveBoss)).toBe(false);
  });

  it("false when there is no manager", () => {
    expect(hasActiveManager(withoutBoss)).toBe(false);
  });

  it("false when managerId is set but the manager relation was not loaded", () => {
    expect(hasActiveManager({ id: "emp", managerId: "boss", manager: null })).toBe(false);
  });
});

describe("canDecide", () => {
  describe("requester with an active direct manager", () => {
    it("the direct manager decides", () => {
      expect(canDecide(boss, withActiveBoss)).toBe(true);
    });

    it("an HR user who is not the direct manager does NOT decide", () => {
      expect(canDecide(hr, withActiveBoss)).toBe(false);
    });

    it("another manager does NOT decide", () => {
      expect(canDecide(otherBoss, withActiveBoss)).toBe(false);
    });

    it("a peer employee does NOT decide", () => {
      expect(canDecide(peer, withActiveBoss)).toBe(false);
    });

    it("an HR user who IS the direct manager decides", () => {
      const hrBoss = actor("hr-boss", "HR");
      expect(canDecide(hrBoss, requester("emp", { id: "hr-boss", isActive: true }))).toBe(true);
    });

    it("the direct manager does NOT decide if the actor is inactive", () => {
      expect(canDecide(actor("boss", "MANAGER", false), withActiveBoss)).toBe(false);
    });
  });

  describe("requester whose manager is inactive", () => {
    it("any active HR decides", () => {
      expect(canDecide(hr, withInactiveBoss)).toBe(true);
    });

    it("the inactive manager does NOT decide", () => {
      expect(canDecide(actor("boss", "MANAGER", false), withInactiveBoss)).toBe(false);
    });

    it("the manager does not decide even if the actor object says active (requester data says inactive)", () => {
      expect(canDecide(boss, withInactiveBoss)).toBe(false);
    });

    it("another MANAGER does NOT decide", () => {
      expect(canDecide(otherBoss, withInactiveBoss)).toBe(false);
    });

    it("an inactive HR does NOT decide", () => {
      expect(canDecide(actor("hr", "HR", false), withInactiveBoss)).toBe(false);
    });
  });

  describe("requester without a manager", () => {
    it("any active HR decides", () => {
      expect(canDecide(hr, withoutBoss)).toBe(true);
    });

    it("a MANAGER does NOT decide", () => {
      expect(canDecide(otherBoss, withoutBoss)).toBe(false);
    });

    it("an EMPLOYEE does NOT decide", () => {
      expect(canDecide(peer, withoutBoss)).toBe(false);
    });

    it("an inactive HR does NOT decide", () => {
      expect(canDecide(actor("hr", "HR", false), withoutBoss)).toBe(false);
    });
  });

  describe("nobody decides their own request", () => {
    it("HR without a manager cannot decide their own request", () => {
      expect(canDecide(actor("hr", "HR"), requester("hr", null))).toBe(false);
    });

    it("HR whose manager is inactive cannot decide their own request", () => {
      expect(canDecide(actor("hr", "HR"), requester("hr", { id: "boss", isActive: false }))).toBe(false);
    });

    it("a manager cannot decide their own request", () => {
      expect(canDecide(actor("boss", "MANAGER"), requester("boss", { id: "director", isActive: true }))).toBe(false);
    });

    it("even with corrupted data where the requester is their own manager", () => {
      expect(canDecide(actor("x", "HR"), requester("x", { id: "x", isActive: true }))).toBe(false);
    });
  });
});

describe("canView", () => {
  it("the requester can view their own request", () => {
    expect(canView(actor("emp", "EMPLOYEE"), { requester: withActiveBoss, deciderId: null })).toBe(true);
  });

  it("an inactive requester still passes canView (auth layer blocks inactive users)", () => {
    expect(canView(actor("emp", "EMPLOYEE", false), { requester: withActiveBoss, deciderId: null })).toBe(true);
  });

  it("any HR can view, even when they cannot decide it", () => {
    expect(canView(hr, { requester: withActiveBoss, deciderId: null })).toBe(true);
  });

  it("the active direct manager (who can decide) can view", () => {
    expect(canView(boss, { requester: withActiveBoss, deciderId: null })).toBe(true);
  });

  it("whoever already decided it can view, even if they no longer can decide", () => {
    expect(canView(otherBoss, { requester: withActiveBoss, deciderId: "other-boss" })).toBe(true);
  });

  it("a peer employee cannot view", () => {
    expect(canView(peer, { requester: withActiveBoss, deciderId: null })).toBe(false);
  });

  it("a manager of another team cannot view", () => {
    expect(canView(otherBoss, { requester: withActiveBoss, deciderId: null })).toBe(false);
  });

  it("the inactive former manager cannot view (not decider, cannot decide)", () => {
    expect(canView(actor("boss", "MANAGER", false), { requester: withInactiveBoss, deciderId: null })).toBe(false);
  });

  it("a manager cannot view a request of someone without a manager unless they decided it", () => {
    expect(canView(otherBoss, { requester: withoutBoss, deciderId: null })).toBe(false);
    expect(canView(otherBoss, { requester: withoutBoss, deciderId: "other-boss" })).toBe(true);
  });
});
