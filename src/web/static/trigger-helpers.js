// Small pure helpers for the trigger page (loaded with a script tag, tested in vitest)

// Splits saved group ids into those still in the tenant and a count of those that left
function splitTenantGroups(jids, groups) {
  const kept = jids.filter(j => groups.some(g => g.jid === j));
  return { kept, droppedCount: jids.length - kept.length };
}

// The note shown when saved groups are no longer in the tenant ('' when none)
function droppedGroupsNote(count) {
  if (count <= 0) return '';
  return count === 1
    ? '1 group is no longer in this tenant and was removed from the list'
    : count + ' groups are no longer in this tenant and were removed from the list';
}
