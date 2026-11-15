// Fixed-step game loop with catch-up, works on Node & browser.
export class Loop {
  constructor({ step = 1 / 60, update, render = null }) {
    this.step = step;
    this.update = update;
    this.render = render;
    this.time = 0;
    this.acc = 0;
    this.maxCatchUp = 8;
    this.tick = 0;
  }
  advance(dt) {
    if (!(dt > 0)) return;
    this.acc += Math.min(dt, 1 / 10);
    let n = 0;
    while (this.acc >= this.step && n < this.maxCatchUp) {
      this.acc -= this.step;
      this.time += this.step;
      this.tick++;
      this.update(this.step);
      n++;
    }
    if (n >= this.maxCatchUp) this.acc = 0;
  }
  startRaf() {
    let last = performance.now();
    const frame = (now) => {
      const dt = (now - last) / 1000;
      last = now;
      this.advance(dt);
      if (this.render) this.render(this.step, this.time);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }
}