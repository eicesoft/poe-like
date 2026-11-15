// Spatial hash grid for fast neighbor queries on the XZ plane.
export class SpatialHash {
  constructor(cell = 2) {
    this.cell = cell;
    this.map = new Map();
    this._stamp = 0;
  }
  _key(x, z) {
    return ((Math.floor(x / this.cell) + 1024) << 12) | (Math.floor(z / this.cell) + 1024);
  }
  insert(obj) {
    const k = this._key(obj.x, obj.z);
    let b = this.map.get(k);
    if (!b) {
      b = [];
      this.map.set(k, b);
    }
    b.push(obj);
    obj.__cell = k;
  }
  rebuild(objs) {
    this.map.clear();
    for (const o of objs) if (!o.dead) this.insert(o);
  }
  remove(obj) {
    const b = this.map.get(obj.__cell);
    if (!b) return;
    const i = b.indexOf(obj);
    if (i >= 0) b.splice(i, 1);
  }
  queryRadius(x, z, r, out = [], filter = null) {
    out.length = 0;
    const c = this.cell;
    const x0 = Math.floor((x - r) / c), x1 = Math.floor((x + r) / c);
    const z0 = Math.floor((z - r) / c), z1 = Math.floor((z + r) / c);
    const r2 = r * r;
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const b = this.map.get(((cx + 1024) << 12) | (cz + 1024));
        if (!b) continue;
        for (let i = 0; i < b.length; i++) {
          const o = b[i];
          if (o.dead) continue;
          const dx = o.x - x, dz = o.z - z;
          if (dx * dx + dz * dz <= r2 && (!filter || filter(o))) out.push(o);
        }
      }
    }
    return out;
  }
  queryCircle(x, z, r, filter = null) {
    return this.queryRadius(x, z, r, [], filter);
  }
}