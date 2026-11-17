/** [Backend Engineer] Injectable clock so tests can move business dates (EAT). */
import { Injectable } from '@nestjs/common';
import { todayEAT } from '@mapema/pricing';

@Injectable()
export class Clock {
  private fixed?: Date;
  now(): Date {
    return this.fixed ? new Date(this.fixed) : new Date();
  }
  today(): string {
    return todayEAT(this.now());
  }
  /** test/dev only */
  set(iso: string | undefined) {
    this.fixed = iso ? new Date(iso) : undefined;
  }
}
