insert into x_users (id, username, name, avatar_url, fetched_at)
select distinct on (author_id) author_id, handle, name,
	(select pictured.avatar_url from posts as pictured where pictured.author_id = posts.author_id and pictured.avatar_url is not null order by pictured.ingested_at desc limit 1),
	ingested_at
from posts
order by author_id, ingested_at desc
on conflict (id) do nothing;

insert into mentions (id, author_id, text, created_at, conversation_id, ingested_at, sources)
select posts.id, posts.author_id, posts.text, posts.created_at, posts.conversation_id, posts.ingested_at,
	case
		when account.user_id is not null and (posts.addressed @> array[account.user_id] or (posts.addressed is null and posts.text ~* ('(^|[^A-Za-z0-9_])@' || account.username || '([^A-Za-z0-9_]|$)'))) then array['mention', 'summons']
		else array['summons']
	end
from posts
left join account on true
on conflict (id) do update set sources = array(select distinct unnest(mentions.sources || excluded.sources) order by 1)
where not mentions.sources @> excluded.sources;

insert into mention_replies (reply_id, mention_id, text, username, created_at, via)
select reply_id, post_id, text, username, created_at, via from replies
on conflict (reply_id) do nothing;

drop table replies, posts, jobs, runs, sync_state, blocklist;
