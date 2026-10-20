import pytest

from conversa.consent import classify_consent


@pytest.mark.parametrize("text", ["sim", "pode rodar", "pode editar", "sim, pode seguir", "Claude, autorizo", "manda ver"])
def test_yes(text):
    assert classify_consent(text) is True


@pytest.mark.parametrize("text", ["não pode", "não", "cancela", "pare", "sim, mas não"])
def test_no(text):
    assert classify_consent(text) is False


@pytest.mark.parametrize("text", ["o que é isso?", "pode?", "hã", "talvez depois", ""])
def test_unknown(text):
    assert classify_consent(text) is None
