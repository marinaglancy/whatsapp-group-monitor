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

// The watched-groups selection of a Spam form: the saved groups still in the tenant,
// and the note markup (only when groups are used and some were dropped)
function watchedGroupsState(cfg, groups) {
  const split = splitTenantGroups(cfg.groupJids, groups);
  const note = cfg.groupsMode === 'all' ? '' : droppedGroupsNote(split.droppedCount);
  return {
    picked: split.kept,
    noteHtml: note ? '<div class="muted" id="s-dropped-note" style="margin:.3rem 0">' + note + '</div>' : '',
  };
}
