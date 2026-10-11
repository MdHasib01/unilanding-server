/**
 * Adds deletedAt and excludes soft-deleted documents from reads by default.
 * Pass { withDeleted: true } as a query option to see them.
 */
export function softDelete(schema) {
  schema.add({ deletedAt: { type: Date, default: null } });

  const hooks = ['find', 'findOne', 'findOneAndUpdate', 'countDocuments', 'distinct'];
  for (const hook of hooks) {
    schema.pre(hook, function (next) {
      const opts = typeof this.getOptions === 'function' ? this.getOptions() : {};
      if (opts?.withDeleted === true) return next();
      const filter = this.getFilter();
      if (filter.deletedAt === undefined) this.where({ deletedAt: null });
      next();
    });
  }

  schema.methods.softRemove = function () {
    this.deletedAt = new Date();
    return this.save();
  };
}
