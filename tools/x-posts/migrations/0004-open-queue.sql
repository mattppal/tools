update posts
set status = 'overflow', reason = 'matched before the queue opened', decided_by = 'sweep', decided_at = now(), summarized_at = now()
where status = 'pending';
