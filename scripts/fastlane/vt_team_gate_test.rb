# vt_team_gate_test.rb — behavioral test for the D-09 team-consistency gate
# (scripts/fastlane/vt_team_gate.rb).
#
# WHY THIS EXISTS: the gate will be `require`d by the Voter's iOS publish lanes (55-04),
# but a gate nobody has ever seen turn red is not a gate, it's a comment.
#
# SEAM: this environment has Ruby 3.2.2 but does NOT have the `fastlane` gem installed
# (bundler can't resolve the app Gemfile.lock's offline-cached gems), so
# `FastlaneCore::UI` — the gate's only external dependency — is unavailable. Rather than
# reimplementing the gate's decision logic in a different language (which would prove
# nothing about THIS script), we `require` the real .rb file verbatim and supply a
# minimal double for the one external symbol it touches (`FastlaneCore::UI.user_error!` /
# `.success`). Every comparison, every regex extraction, every branch below runs the
# actual production Ruby.
#
# Run: ruby scripts/fastlane/vt_team_gate_test.rb

require "minitest/autorun"
require "fileutils"
require "tmpdir"

# --- Minimal double for the gate's ONLY external dependency ----------------------------
# Real FastlaneCore::UI.user_error! raises and aborts the Fastlane run; real .success
# prints and returns. We reproduce exactly that contract (raise vs. return) so the gate's
# fail-closed branches are observable as Ruby exceptions in a plain test process.
module FastlaneCore
  module UI
    class Error < StandardError; end

    class << self
      attr_accessor :last_success_message

      def user_error!(msg)
        raise Error, msg
      end

      def success(msg)
        self.last_success_message = msg
      end
    end
  end
end

# This must come AFTER the FastlaneCore::UI double above — vt_team_gate.rb evaluates
# `UI = FastlaneCore::UI` at module body load time, so the double has to exist first.
GATE_PATH = File.expand_path("vt_team_gate.rb", __dir__)
require GATE_PATH

REPO_ROOT = File.expand_path("../..", __dir__)
PBXPROJ_RELATIVE = File.join(
  "apps", "VoteTorrentVoter", "ios", "VoteTorrentVoter.xcodeproj", "project.pbxproj"
)
GENERATED_RELATIVE = File.join(
  "apps", "VoteTorrentAuthority", "src", "engines", "appattest-keys.generated.ts"
)

class VtTeamGateTest < Minitest::Test
  def setup
    FastlaneCore::UI.last_success_message = nil
  end

  # --- helpers ---------------------------------------------------------------------

  def with_fixture_repo(debug_team:, release_team:, app_id: "6849Q7KVP5.org.votetorrent.voter")
    pbxproj_text = <<~PBXPROJ
      /* Begin XCBuildConfiguration section */
      		13B07F941A680F5B00A75B9A /* Debug */ = {
      			isa = XCBuildConfiguration;
      			buildSettings = {
      				DEVELOPMENT_TEAM = #{debug_team};
      				PRODUCT_BUNDLE_IDENTIFIER = org.votetorrent.voter;
      			};
      			name = Debug;
      		};
      		13B07F951A680F5B00A75B9A /* Release */ = {
      			isa = XCBuildConfiguration;
      			buildSettings = {
      				DEVELOPMENT_TEAM = #{release_team};
      				PRODUCT_BUNDLE_IDENTIFIER = org.votetorrent.voter;
      			};
      			name = Release;
      		};
      /* End XCBuildConfiguration section */
    PBXPROJ
    with_raw_fixture_repo(pbxproj_text: pbxproj_text, app_id: app_id) { |dir| yield dir }
  end

  def with_raw_fixture_repo(pbxproj_text:, app_id: "6849Q7KVP5.org.votetorrent.voter")
    Dir.mktmpdir("vt-team-gate-") do |dir|
      pbxproj_path = File.join(dir, PBXPROJ_RELATIVE)
      FileUtils.mkdir_p(File.dirname(pbxproj_path))
      File.write(pbxproj_path, pbxproj_text)

      generated_path = File.join(dir, GENERATED_RELATIVE)
      FileUtils.mkdir_p(File.dirname(generated_path))
      File.write(
        generated_path,
        <<~TS
          // fixture, not the real file
          export const APPLE_APP_ID = '#{app_id}';
        TS
      )

      yield dir
    end
  end

  # --- GREEN: the gate must pass genuinely consistent config -----------------------

  def test_passes_the_real_committed_repo
    VtTeamGate.assert_team!(REPO_ROOT)
    assert_match(/consistent/, FastlaneCore::UI.last_success_message)
  end

  def test_passes_a_consistent_fixture
    with_fixture_repo(debug_team: "6849Q7KVP5", release_team: "6849Q7KVP5") do |repo|
      VtTeamGate.assert_team!(repo)
      assert_match(/consistent/, FastlaneCore::UI.last_success_message)
    end
  end

  # --- RED: the gate must refuse every inconsistent/unparseable input --------------

  def test_refuses_a_mistyped_but_wellformed_team_id
    with_fixture_repo(debug_team: "6849Q7KVP4", release_team: "6849Q7KVP4") do |repo|
      err = assert_raises(FastlaneCore::UI::Error) do
        VtTeamGate.assert_team!(repo)
      end
      assert_match(/mistyped-but-well-formed/, err.message)
    end
  end

  def test_refuses_the_old_personal_team_id
    with_fixture_repo(debug_team: "94TY7UR2W5", release_team: "94TY7UR2W5") do |repo|
      err = assert_raises(FastlaneCore::UI::Error) do
        VtTeamGate.assert_team!(repo)
      end
      assert_match(/OLD FREE PERSONAL TEAM/, err.message)
    end
  end

  def test_refuses_configs_that_disagree
    with_fixture_repo(debug_team: "6849Q7KVP5", release_team: "94TY7UR2W5") do |repo|
      err = assert_raises(FastlaneCore::UI::Error) do
        VtTeamGate.assert_team!(repo)
      end
      assert_match(/disagree/, err.message)
      assert_match(/6849Q7KVP5/, err.message)
      assert_match(/94TY7UR2W5/, err.message)
    end
  end

  def test_refuses_a_pbxproj_with_only_one_development_team_line
    pbxproj_text = <<~PBXPROJ
      /* Begin XCBuildConfiguration section */
      		13B07F941A680F5B00A75B9A /* Debug */ = {
      			isa = XCBuildConfiguration;
      			buildSettings = {
      				DEVELOPMENT_TEAM = 6849Q7KVP5;
      			};
      			name = Debug;
      		};
      /* End XCBuildConfiguration section */
    PBXPROJ
    with_raw_fixture_repo(pbxproj_text: pbxproj_text) do |repo|
      err = assert_raises(FastlaneCore::UI::Error) do
        VtTeamGate.assert_team!(repo)
      end
      assert_match(/found only 1/, err.message)
    end
  end

  def test_refuses_a_pbxproj_with_no_development_team_at_all
    pbxproj_text = <<~PBXPROJ
      /* Begin XCBuildConfiguration section */
      		13B07F941A680F5B00A75B9A /* Debug */ = {
      			isa = XCBuildConfiguration;
      			buildSettings = {
      				PRODUCT_BUNDLE_IDENTIFIER = org.votetorrent.voter;
      			};
      			name = Debug;
      		};
      /* End XCBuildConfiguration section */
    PBXPROJ
    with_raw_fixture_repo(pbxproj_text: pbxproj_text) do |repo|
      err = assert_raises(FastlaneCore::UI::Error) do
        VtTeamGate.assert_team!(repo)
      end
      assert_match(/found only 0/, err.message)
    end
  end

  def test_refuses_a_blank_quoted_development_team
    with_fixture_repo(debug_team: '""', release_team: '""') do |repo|
      err = assert_raises(FastlaneCore::UI::Error) do
        VtTeamGate.assert_team!(repo)
      end
      assert_match(/empty/, err.message)
    end
  end

  def test_refuses_a_missing_pbxproj
    Dir.mktmpdir("vt-team-gate-missing-") do |repo|
      err = assert_raises(FastlaneCore::UI::Error) do
        VtTeamGate.assert_team!(repo)
      end
      assert_match(/could not find/, err.message)
    end
  end

  def test_refuses_a_missing_generated_file
    Dir.mktmpdir("vt-team-gate-no-generated-") do |repo|
      pbxproj_path = File.join(repo, PBXPROJ_RELATIVE)
      FileUtils.mkdir_p(File.dirname(pbxproj_path))
      File.write(
        pbxproj_path,
        <<~PBXPROJ
          		13B07F941A680F5B00A75B9A /* Debug */ = {
          			buildSettings = {
          				DEVELOPMENT_TEAM = 6849Q7KVP5;
          			};
          		};
          		13B07F951A680F5B00A75B9A /* Release */ = {
          			buildSettings = {
          				DEVELOPMENT_TEAM = 6849Q7KVP5;
          			};
          		};
        PBXPROJ
      )
      err = assert_raises(FastlaneCore::UI::Error) do
        VtTeamGate.assert_team!(repo)
      end
      assert_match(/could not find/, err.message)
    end
  end

  def test_refuses_an_unparseable_generated_file
    Dir.mktmpdir("vt-team-gate-unparseable-") do |repo|
      pbxproj_path = File.join(repo, PBXPROJ_RELATIVE)
      FileUtils.mkdir_p(File.dirname(pbxproj_path))
      File.write(
        pbxproj_path,
        <<~PBXPROJ
          		13B07F941A680F5B00A75B9A /* Debug */ = {
          			buildSettings = {
          				DEVELOPMENT_TEAM = 6849Q7KVP5;
          			};
          		};
          		13B07F951A680F5B00A75B9A /* Release */ = {
          			buildSettings = {
          				DEVELOPMENT_TEAM = 6849Q7KVP5;
          			};
          		};
        PBXPROJ
      )
      generated_path = File.join(repo, GENERATED_RELATIVE)
      FileUtils.mkdir_p(File.dirname(generated_path))
      File.write(generated_path, "// no exported consts at all\n")

      err = assert_raises(FastlaneCore::UI::Error) do
        VtTeamGate.assert_team!(repo)
      end
      assert_match(/could not find/, err.message)
    end
  end

  def test_refuses_a_team_prefix_mismatch_against_the_authority_app_id
    with_fixture_repo(
      debug_team: "6849Q7KVP5",
      release_team: "6849Q7KVP5",
      app_id: "ZZZZ999999.org.votetorrent.voter"
    ) do |repo|
      err = assert_raises(FastlaneCore::UI::Error) do
        VtTeamGate.assert_team!(repo)
      end
      assert_match(/team prefix mismatch/, err.message)
      assert_match(/ZZZZ999999/, err.message)
    end
  end

  def test_refuses_a_mutated_copy_of_the_real_pbxproj
    real_pbxproj_path = File.join(REPO_ROOT, PBXPROJ_RELATIVE)
    mutated_text = File.read(real_pbxproj_path).gsub("6849Q7KVP5", "ZZZZ999999")

    with_raw_fixture_repo(pbxproj_text: mutated_text) do |repo|
      err = assert_raises(FastlaneCore::UI::Error) do
        VtTeamGate.assert_team!(repo)
      end
      assert_match(/ZZZZ999999/, err.message)
    end
  end
end
