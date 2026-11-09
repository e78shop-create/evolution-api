"""Documented fetch_rows shape: static string concatenation, plus non-SQL Message parsing."""

INTERVAL = 30
SKIP_TYPES = ("stub", "protocol")


BASE_WHERE = """
"instanceId" = (select id from "Instance" where name = %s)
AND "messageTimestamp" >= %s
AND coalesce(key->>'fromMe','false') = 'false'
AND (remoteJid matches user/lid/allowed-group patterns)
AND "messageType" NOT IN %s
"""


def message_type_name(value):
    if value.endswith("Message"):
        return value.replace("Message", "")
    return value


def candidate_ids(since):
    sql = "SELECT id FROM \"Message\" WHERE " + BASE_WHERE
    return sql, since


def fetch_rows(keyids):
    sql = (
        "select id, status, message from \"Message\" where \"instanceId\" = (select id from \"Instance\" where name = %s) "
        + "and key->>'id' in (%s)"
    )
    return sql, keyids
