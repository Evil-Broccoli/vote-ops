import json
from unittest.mock import Mock, patch

from vote.app import app


# 首页 GET 只负责返回页面和设置身份，不应访问 Redis
def test_get_home_sets_voter_cookie_without_redis():
    with patch("vote.app.get_redis") as get_redis:
        response = app.test_client().get("/")

    assert response.status_code == 200
    assert "voter_id=" in response.headers["Set-Cookie"]
    get_redis.assert_not_called()


# 合法投票必须写入一次队列，并保留固定的投票者身份
def test_valid_vote_is_pushed_to_redis_with_voter_id():
    redis = Mock()
    client = app.test_client()
    client.set_cookie("voter_id", "test-voter")

    with patch("vote.app.get_redis", return_value=redis):
        response = client.post("/", data={"vote": "a"})

    assert response.status_code == 200
    redis.rpush.assert_called_once()
    queue_name, payload = redis.rpush.call_args.args
    assert queue_name == "votes"
    assert json.loads(payload) == {"voter_id": "test-voter", "vote": "a"}


# 非法选项应在接触 Redis 前被拒绝，避免污染消息队列
def test_invalid_vote_is_rejected_before_queue_write():
    redis = Mock()

    with patch("vote.app.get_redis", return_value=redis):
        response = app.test_client().post("/", data={"vote": "invalid"})

    assert response.status_code == 400
    redis.rpush.assert_not_called()


# 存活检查只判断进程能否处理请求，不绑定 Redis 的状态
def test_healthz_does_not_require_redis():
    with patch("vote.app.get_redis") as get_redis:
        response = app.test_client().get("/healthz")

    assert response.status_code == 200
    assert response.get_json() == {"status": "ok"}
    get_redis.assert_not_called()


# Redis 可访问时，vote 才具备接收新投票的就绪条件
def test_readyz_reports_ready_when_redis_ping_succeeds():
    redis = Mock()
    redis.ping.return_value = True

    with patch("vote.app.get_redis", return_value=redis):
        response = app.test_client().get("/readyz")

    assert response.status_code == 200
    assert response.get_json() == {"status": "ready"}
    redis.ping.assert_called_once_with()


# Redis 故障时返回 503，让上游停止继续转发投票流量
def test_readyz_reports_not_ready_when_redis_ping_fails():
    redis = Mock()
    redis.ping.side_effect = ConnectionError("redis unavailable")

    with patch("vote.app.get_redis", return_value=redis):
        response = app.test_client().get("/readyz")

    assert response.status_code == 503
    assert response.get_json() == {"status": "not-ready"}
    redis.ping.assert_called_once_with()
