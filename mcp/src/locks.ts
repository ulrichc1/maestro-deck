/**
 * One operation at a time per device for anything that talks to the Maestro driver
 * (hierarchy, ad-hoc steps). Two at once would fight over the same driver port.
 */
export class DeviceLocks {
  private held = new Map<string, string>();

  /** Takes the device or throws, saying who holds it. */
  acquire(deviceId: string, who: string): () => void {
    const holder = this.held.get(deviceId);
    if (holder) throw new Error(`${deviceId} is busy: ${holder}. Wait for it to finish.`);
    this.held.set(deviceId, who);
    return () => {
      if (this.held.get(deviceId) === who) this.held.delete(deviceId);
    };
  }

  isHeld(deviceId: string): string | undefined {
    return this.held.get(deviceId);
  }
}
