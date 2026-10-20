from conversa.transcript import clean_transcript


def test_noise_tag_and_phantom_are_dropped():
    assert clean_transcript("[música] obrigado por assistir") == ""


def test_filler_only_is_dropped():
    assert clean_transcript("hm") == ""
    assert clean_transcript("hum, ah") == ""


def test_prompt_echo_is_dropped():
    assert clean_transcript("claude code pytest", "glossário: claude code pytest typescript") == ""


def test_real_speech_is_kept_and_trimmed():
    assert clean_transcript(", roda os testes  (tosse) agora") == "roda os testes agora"


def test_single_word_from_prompt_is_kept():
    assert clean_transcript("pytest", "pytest typescript") == "pytest"
