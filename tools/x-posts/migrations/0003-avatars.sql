drop table reposts;

alter table posts add column avatar_url text check (avatar_url is null or avatar_url like 'https://pbs.twimg.com/%');
