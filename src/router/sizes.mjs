export const MACHINE_SIZES = Object.freeze(['small', 'default', 'large', 'xlarge']);
export const validMachineSize = size => MACHINE_SIZES.includes(size);
// A lease is a general-purpose machine a client runs its own work on; the
// provider's xlarge type stays available to CI, not to a lease client.
export const LEASE_SIZES = Object.freeze(['small', 'default', 'large']);
export const validLeaseSize = size => validMachineSize(size) && LEASE_SIZES.includes(size);
