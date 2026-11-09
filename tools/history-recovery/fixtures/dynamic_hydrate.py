"""Dynamic SQL is not a supported fetch_rows shape."""

BASE_WHERE = """
"instanceId" = (select id from "Instance" where name = %s)
AND "messageTimestamp" >= %s
AND coalesce(key->>'fromMe','false') = 'false'
AND (remoteJid matches user/lid/allowed-group patterns)
AND "messageType" NOT IN %s
"""


def candidate_ids(since):
    return BASE_WHERE


def fetch_rows(keyids):
    extra = "and key->>'id' in (%s)"
    sql = "select id from \"Message\" where \"instanceId\" = %s " + extra
    return sql
