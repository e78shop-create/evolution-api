"""Second Message reader outside the documented functions."""

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
    sql = """
    SELECT id FROM "Message" WHERE "instanceId" = %s AND key->>'id' IN %s
    """
    return sql


def retry_ids():
    return 'SELECT id FROM "Message" WHERE "messageTimestamp" >= %s'
