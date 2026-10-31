# Draft Homebrew formula (tap: zulu-assistant/homebrew-tap). Installs only the
# `zulu` launcher; the app itself lives in a git clone (default ~/zulu-assistant)
# because it writes data/ and overlay/ next to its code.
class ZuluAssistant < Formula
  desc "Local ops board and agent workforce for the Mac that runs your automations"
  homepage "https://github.com/zulu-assistant/zulu-assistant"
  url "https://github.com/zulu-assistant/zulu-assistant/archive/refs/tags/v1.0.0.tar.gz"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000" # filled at release
  license "MIT"
  head "https://github.com/zulu-assistant/zulu-assistant.git", branch: "main"

  depends_on :macos
  depends_on "node@22"
  depends_on "gh" => :recommended

  def install
    (bin/"zulu").write <<~SH
      #!/bin/bash
      # zulu <install.sh args> — clones the app on first use, then runs its installer
      set -euo pipefail
      home="${ZULU_HOME:-$HOME/zulu-assistant}"
      [[ -d "$home/.git" ]] || git clone --depth 1 https://github.com/zulu-assistant/zulu-assistant.git "$home"
      export PATH="#{Formula["node@22"].opt_bin}:$PATH"
      exec "$home/install.sh" "$@"
    SH
  end

  def caveats
    <<~EOS
      Try it with synthetic data first:  zulu --demo   (then open http://localhost:3210)
      Full install:                      zulu
      cmux (the agent terminal) is separate: brew install --cask cmux
    EOS
  end

  test do
    assert_predicate bin/"zulu", :executable?
  end
end
