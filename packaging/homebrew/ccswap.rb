# Typical placement: homebrew-tap repo at Formula/ccswap.rb
# Install via: brew install chenjingdev/tap/ccswap
#
# When publishing, update `version` and recompute the sha256 with:
#   curl -fsSL https://registry.npmjs.org/ccswap/-/ccswap-<version>.tgz | shasum -a 256
class Ccswap < Formula
  desc "Multi-account Claude Code switcher with auto-swap on limit"
  homepage "https://github.com/chenjingdev/ccswap"
  url "https://registry.npmjs.org/ccswap/-/ccswap-0.1.0.tgz"
  sha256 "REPLACE_WITH_RELEASE_SHA256"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", "-g", *Language::Node.std_npm_install_args(libexec)
    bin.install_symlink Dir["#{libexec}/bin/ccswap"]
  end

  test do
    assert_match "ccswap", shell_output("#{bin}/ccswap --version")
  end
end
