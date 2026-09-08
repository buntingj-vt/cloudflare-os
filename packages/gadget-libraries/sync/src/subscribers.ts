/**
 * The browsers subscribed to one Durable Object, and how events reach them.
 *
 * A subscriber arrives as the client's `RpcTarget`, seen from here through a Workers RPC stub that
 * is only valid for the call that delivered it. Keeping it means `dup()`-ing it, and dropping it
 * means disposing that copy; the runtime's `onRpcBroken` says when the connection behind it went
 * away. Delivery isolates subscribers from each other: one whose call fails is dropped rather than
 * failing the mutation that was being broadcast, and the rest are told it left -- exactly as they
 * would be had its connection closed.
 *
 * Presence is the one thing the registry knows how to say itself, through the optional
 * {@link PresenceHooks}: a newcomer is first told about everyone already here, then announced to
 * everyone, and whoever drops out is announced as gone. What a "join" or "leave" looks like on the
 * wire is the gadget's, so the hooks express it in the gadget's own callback vocabulary. A gadget
 * with no presence (a deck everyone sees the same way) passes no hooks and gets a plain fan-out.
 */

/**
 * What the RPC layer adds to a subscriber's callbacks: the `dup` that keeps it past the call that
 * delivered it, the disposer that releases it, and the disconnection hook.
 */
export interface SubscriberStub {
  /** A copy that survives the end of the RPC call this stub arrived in. */
  dup(): this;
  /** Runs once when the connection behind this stub is gone. */
  onRpcBroken(handler: (error: unknown) => void): void;
  /** Releases this stub. */
  [Symbol.dispose](): void;
}

/**
 * How the registry announces presence, in the gadget's own callback vocabulary. Each hook sends
 * one message to one subscriber and may return a promise; a rejection drops that subscriber.
 */
export interface PresenceHooks<Callbacks, Info> {
  /** Tell `subscriber` that `who` is here: what a newcomer hears about each earlier arrival, and everyone about the newcomer. */
  join(subscriber: Callbacks, who: Info): unknown;
  /** Tell `subscriber` that `who` is gone. */
  leave(subscriber: Callbacks, who: Info): unknown;
}

/**
 * The subscribers of one object, each with what it said about itself on arrival (`Info`; `void`
 * for a gadget that keeps nothing per subscriber). `Callbacks` is the interface the client's
 * `RpcTarget` implements.
 */
export class SubscriberRegistry<Callbacks extends object, Info = void> {
  readonly #subscribers = new Map<Callbacks & SubscriberStub, Info>();
  readonly #presence: PresenceHooks<Callbacks, Info> | null;

  constructor(presence?: PresenceHooks<Callbacks, Info>) {
    this.#presence = presence ?? null;
  }

  /** How many subscribers are registered. */
  get size(): number {
    return this.#subscribers.size;
  }

  /** What each subscriber said about itself, in order of arrival. */
  members(): Info[] {
    return Array.from(this.#subscribers.values());
  }

  /**
   * Keep `subscriber` -- the stub the RPC layer delivered, typed as the client implements it --
   * until its connection breaks or it fails a delivery, and announce its presence when hooks are
   * set: it is seeded with everyone already here, all at once, and then announced to everyone,
   * after the current task so that the call that subscribed it returns first. A newcomer that
   * fails a seed is gone already: it is dropped and, since nobody has heard of it, announced to
   * no one. Returns the kept handle, for {@link remove}.
   */
  add(subscriber: Callbacks, who: Info): Callbacks {
    const stub = (subscriber as Callbacks & SubscriberStub).dup();
    const others = this.members();
    this.#subscribers.set(stub, who);
    stub.onRpcBroken(() => {
      if (this.#drop(stub)) void this.#announceLeave([who]);
    });
    const presence = this.#presence;
    if (presence) {
      queueMicrotask(async () => {
        // A newcomer gone already -- removed or broken since it was added, or failing a seed -- is
        // seeded and announced no further: nobody has heard of it.
        if (!this.#subscribers.has(stub)) return;
        const seeds = await Promise.allSettled(others.map((person) => Promise.resolve().then(() => presence.join(stub, person))));
        if (seeds.some((seed) => seed.status === "rejected")) this.#drop(stub);
        if (!this.#subscribers.has(stub)) return;
        await this.broadcast((each) => presence.join(each, who));
      });
    }
    return stub;
  }

  /**
   * Forget a subscriber before its connection breaks, release its stub and announce that it left.
   * Returns whether it was registered.
   */
  async remove(subscriber: Callbacks): Promise<boolean> {
    const stub = subscriber as Callbacks & SubscriberStub;
    const who = this.#subscribers.get(stub) as Info;
    if (!this.#drop(stub)) return false;
    await this.#announceLeave([who]);
    return true;
  }

  /**
   * Deliver to every subscriber at once. One whose call rejects is dropped rather than failing the
   * caller, and the rest are told it left. Resolves once every delivery has settled.
   */
  async broadcast(send: (subscriber: Callbacks) => unknown): Promise<void> {
    const gone: Info[] = [];
    await Promise.all(
      Array.from(this.#subscribers.keys(), (stub) =>
        Promise.resolve()
          .then(() => send(stub))
          .catch(() => {
            const who = this.#subscribers.get(stub) as Info;
            if (this.#drop(stub)) gone.push(who);
          }),
      ),
    );
    if (gone.length) await this.#announceLeave(gone);
  }

  /** Tell everyone still here that each of `gone` left, when there is a vocabulary to say it in. */
  async #announceLeave(gone: Info[]): Promise<void> {
    const presence = this.#presence;
    if (!presence) return;
    for (const who of gone) await this.broadcast((each) => presence.leave(each, who));
  }

  /**
   * Forget a subscriber and release the stub `add` kept. Returns whether it was registered, so a
   * failure and a broken connection reported together drop -- and announce -- it once.
   */
  #drop(stub: Callbacks & SubscriberStub): boolean {
    if (!this.#subscribers.delete(stub)) return false;
    stub[Symbol.dispose]();
    return true;
  }
}
