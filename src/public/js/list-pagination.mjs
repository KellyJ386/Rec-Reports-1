// Pure client-side pagination for lists whose backing route has no
// `?limit=`/`?offset=` support (incidents, incident escalations/follow-ups/
// amendments, messages -- see each panel's controller in app.js for which
// endpoint it slices). Work orders instead paginate server-side via its own
// `?limit=&offset=` (WO-05); see work-order-filters.mjs for that query
// builder. Kept separate and reusable so every "growing list" panel this
// batch touches shares one tested slicing rule instead of five near-copies.
//
// No I/O, no DOM -- `items` is whatever array the caller already fetched.
export function paginate(items, page = 1, pageSize = 5) {
  const list = Array.isArray(items) ? items : [];
  const size = Math.max(1, Math.trunc(pageSize) || 1);
  const totalPages = Math.max(1, Math.ceil(list.length / size));
  const requestedPage = Math.trunc(page) || 1;
  const clampedPage = Math.min(Math.max(1, requestedPage), totalPages);
  const start = (clampedPage - 1) * size;

  return {
    pageItems: list.slice(start, start + size),
    page: clampedPage,
    pageSize: size,
    total: list.length,
    totalPages,
    hasPrev: clampedPage > 1,
    hasNext: clampedPage < totalPages
  };
}
