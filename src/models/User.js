import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { AppError } from '../utils/AppError.js';
import { USER_SCOPES, ALL_ROLES, PLATFORM_ROLES, TENANT_ROLES, LOCALES, DEFAULT_LOCALE } from '../utils/constants.js';

const BCRYPT_ROUNDS = 12;

/**
 * One collection for platform staff and tenant users, discriminated by `scope`.
 * Login, password reset, invites and mustChangePassword are identical flows;
 * two collections would duplicate every one of them. The same email may exist
 * once as a platform user and once per tenant — they are different principals.
 */
const userSchema = new mongoose.Schema(
  {
    // null means a platform user. Explicitly null rather than absent so the
    // compound unique index below behaves predictably.
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', default: null },
    scope: { type: String, enum: USER_SCOPES, required: true },
    role: { type: String, enum: ALL_ROLES, required: true },

    name: { type: String, required: [true, 'Name is required'], trim: true },
    email: {
      type: String,
      required: [true, 'Email is required'],
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, 'Invalid email address'],
    },
    passwordHash: { type: String, required: true, select: false },
    phone: { type: String, default: '', trim: true },
    avatar: { url: { type: String, default: '' }, publicId: { type: String, default: '' } },

    /** Dashboard language preference; seeds the UL_LOCALE cookie at login. */
    locale: { type: String, enum: LOCALES, default: DEFAULT_LOCALE },

    mustChangePassword: { type: Boolean, default: true },
    active: { type: Boolean, default: true },

    lastLoginAt: { type: Date, default: null },
    lastLoginIp: { type: String, default: '' },
    /** Any token issued before this instant is rejected. */
    passwordChangedAt: { type: Date, default: null },
    /** Bumped to force-logout every session for this user. */
    tokenVersion: { type: Number, default: 0 },

    /**
     * Password-reset token, stored HASHED exactly like a password: a leaked
     * database must not hand over working reset links. Persisted rather than
     * held in memory so a deploy restart does not invalidate outstanding links.
     */
    passwordResetHash: { type: String, default: '', select: false },
    passwordResetExpiresAt: { type: Date, default: null, select: false },

    invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

// A tenant's emails are unique within that tenant; platform emails (tenantId
// null) are unique globally, because null participates in the index.
userSchema.index({ tenantId: 1, email: 1 }, { unique: true });
userSchema.index({ tenantId: 1, role: 1 });
userSchema.index({ email: 1 });

userSchema.pre('validate', function (next) {
  const isPlatform = this.scope === 'platform';
  const hasTenant = this.tenantId !== null && this.tenantId !== undefined;
  if (isPlatform === hasTenant) {
    return next(
      new AppError(
        'Platform users must have tenantId null; tenant users must have a tenantId',
        422,
        'USER_SCOPE_MISMATCH'
      )
    );
  }
  const allowed = isPlatform ? PLATFORM_ROLES : TENANT_ROLES;
  if (!allowed.includes(this.role)) {
    return next(
      new AppError(
        `Role "${this.role}" is not valid for scope "${this.scope}"`,
        422,
        'USER_ROLE_MISMATCH'
      )
    );
  }
  next();
});

userSchema.methods.comparePassword = function (plain) {
  return bcrypt.compare(plain, this.passwordHash);
};

userSchema.statics.hashPassword = function (plain) {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
};

/** passwordHash is select:false, so login must ask for it explicitly. */
userSchema.statics.findForLogin = function ({ email, tenantId = null }) {
  return this.findOne({ email: String(email).toLowerCase().trim(), tenantId }).select(
    '+passwordHash'
  );
};

/** The ONLY serializer. Never spread a user document into a response. */
userSchema.methods.toSafeJSON = function () {
  return {
    id: this._id,
    tenantId: this.tenantId,
    scope: this.scope,
    role: this.role,
    name: this.name,
    email: this.email,
    phone: this.phone,
    avatar: this.avatar,
    locale: this.locale,
    mustChangePassword: this.mustChangePassword,
    active: this.active,
    lastLoginAt: this.lastLoginAt,
    createdAt: this.createdAt,
  };
};

export const User = mongoose.model('User', userSchema);
export default User;
