export function sameFacility(refs, facilityId) {
  return refs.every((ref) => ref === null || ref === undefined || ref.facilityId === facilityId);
}
